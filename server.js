const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const pdf = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { pdfToPng } = require('pdf-to-png-converter');

const app = express();

// Ensure uploads directory exists in /tmp (writable in serverless)
const UPLOAD_DIR = '/tmp/uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOAD_DIR + '/' });

// Store SSE connections
const clients = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper for OCR (Stateless for /process-single)
async function performOCR(pdfPath, _uploadId, _count, _total) {
    try {
        console.log(`[OCR] Iniciando OCR para: ${pdfPath}`);
        // Removed sendProgress calls as we are now stateless per request

        // Convert only the first page to image
        const pages = await pdfToPng(pdfPath, {
            viewportScale: 1.5,
            pagesToProcess: [1]
        });

        if (pages.length === 0 || !pages[0].content) {
            console.log('[OCR] Nenhuma imagem gerada do PDF');
            return '';
        }

        const ocrPromise = Tesseract.recognize(
            Buffer.from(pages[0].content),
            'por',
            {
                cachePath: '/tmp/tesseract-cache',
                gzip: false,
                logger: m => {
                    // console.log(m.progress); // Optional logging
                }
            }
        );

        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
            console.log('[OCR] Timeout de segurança atingido (9s)');
            resolve({ data: { text: '' } });
        }, 9000));

        const result = await Promise.race([ocrPromise, timeoutPromise]);
        return result.data.text;

    } catch (err) {
        console.error('[OCR ERROR]', err);
        return '';
    }
}
// Helper to validate and normalize a 13-char candidate
function validateAndNormalizeCode(segment) {
    if (!segment || segment.length < 13) return null;

    // Ensure we take exactly 13 chars
    const sub = segment.substring(0, 13);
    const prefix = sub.substring(0, 2);
    const middle = sub.substring(2, 11);
    const suffix = sub.substring(11, 13);

    // Prefix and Suffix must be letters
    if (!/^[A-Z]{2}$/.test(prefix) || !/^[A-Z]{2}$/.test(suffix)) return null;

    // Middle must be digits (with fuzzy correction)
    const digits = middle
        .replace(/O/g, '0').replace(/S/g, '5').replace(/Z/g, '2')
        .replace(/I/g, '1').replace(/L/g, '1').replace(/B/g, '8').replace(/G/g, '6');

    if (/^\d{9}$/.test(digits)) {
        return `${prefix}${digits}${suffix}`;
    }
    return null;
}

// Robust search for tracking code in any text
function findTrackingCode(text) {
    if (!text) return null;

    // 1. Context Search: Prioritize codes near keywords (Highest Priority)
    // Refined regex to handle (RASTREAMENTO) and other variations
    const contextRegex = /(?:OBJETO(?:\s*\(RASTREAMENTO\))?|RASTREAMENTO|CORREIOS)\s*[:\-]?\s*([A-Z0-9\s\.]{13,30})/gi;
    let contextMatch;
    while ((contextMatch = contextRegex.exec(text)) !== null) {
        const raw = contextMatch[1].replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const code = validateAndNormalizeCode(raw);

        // MANDATORY: In this project, correct codes ALWAYS end in BR
        if (code && code.endsWith('BR')) {
            console.log(`[MATCH] Prioridade Máxima (Contexto + BR): ${code}`);
            return code;
        }
    }

    // 2. Scan whole text for candidates with ranking system
    const cleaned = text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const candidates = [];

    for (let i = 0; i <= cleaned.length - 13; i++) {
        const segment = cleaned.substring(i, i + 13);
        const code = validateAndNormalizeCode(segment);

        // Only consider codes that end in BR (as specified by user)
        if (code && code.endsWith('BR')) {
            let score = 100; // Base score for BR codes

            // Penalty for "barcode noise" even if it ends in BR by some miracle
            const middleDigits = code.substring(2, 11);
            const uniqueChars = new Set(middleDigits).size;

            if (uniqueChars <= 3) score -= 80;
            if (middleDigits === '111111111' || middleDigits === '000000000') score -= 150;
            if (code.startsWith('LI')) score -= 50;

            candidates.push({ code, score });
        }
    }

    if (candidates.length > 0) {
        // Sort by score descending
        candidates.sort((a, b) => b.score - a.score);

        console.log(`[DEBUG] Melhor candidato BR: ${candidates[0].code} (Score: ${candidates[0].score})`);

        // Only return if it's a high-quality match
        if (candidates[0].score > 0) {
            return candidates[0].code;
        }
    }

    return null;
}

// PROCESS SINGLE FILE (Client-Side Orchestration Pattern)
app.post('/process-single', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
        }

        console.log(`[PROCESS] Iniciando arquivo: ${req.file.originalname}`);
        const filePath = req.file.path;

        let fullText = '';
        try {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            fullText = data.text;
        } catch (err) {
            console.error('[PDF ERROR]', err);
            // Don't fail yet, try OCR if text extraction fails (although rare for corrupt files)
        }

        // Strategy: Text Search -> OCR Fallback
        let code = findTrackingCode(fullText);
        let method = 'text';

        if (!code) {
            // Need OCR
            // Mock uploadId and counts for log compatibility, or simplify logging
            const tempId = Date.now().toString();
            const ocrText = await performOCR(filePath, tempId, 1, 1);
            if (ocrText) {
                code = findTrackingCode(ocrText);
                method = 'ocr';
            }
        }

        // Cleanup temp upload immediately
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        if (code) {
            console.log(`[SUCCESS] Código encontrado: ${code} (${method})`);
            return res.json({
                success: true,
                originalName: req.file.originalname,
                newName: `${code}.pdf`,
                code: code,
                method: method
            });
        } else {
            console.log(`[FAIL] Nenhum código encontrado em: ${req.file.originalname}`);
            return res.status(200).json({
                success: false,
                originalName: req.file.originalname,
                error: 'Código não encontrado ou ilegível.'
            });
        }

    } catch (error) {
        console.error('SERVER ERROR:', error);
        // Cleanup if error occurred before unlink
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        return res.status(500).json({ error: error.message });
    }
});

// Remove old SSE and Download endpoints if no longer needed, 
// OR keep /download if you want to support server-generated files (but we are moving to client-zip)
// For now, I will comment them out or leave them as legacy/fallback if user hits old endpoint.
// But valid clean-up means removing unused code to save memory/confusion.

// ... (Rest of utils like performOCR remain, but sendProgress inside it needs handling) ...
// Since performOCR calls sendProgress, I need to stub it or remove the dependency.


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
