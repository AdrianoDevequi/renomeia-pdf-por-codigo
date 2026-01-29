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

// SSE Endpoint
app.get('/events/:id', (req, res) => {
    const id = req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Critical for Nginx/Apache proxies to support SSE without buffering
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    clients.set(id, res);

    req.on('close', () => {
        clients.delete(id);
    });
});

// Download Endpoint
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    // Use /tmp/output for downloads
    const filePath = path.join('/tmp/output', filename);

    console.log(`[DOWNLOAD] Solicitado: ${filename}`);
    console.log(`[DOWNLOAD] Caminho completo: ${filePath}`);

    if (!fs.existsSync(filePath)) {
        console.error('[DOWNLOAD] Arquivo não encontrado no disco.');
        return res.status(404).send('Arquivo não encontrado.');
    }

    // Set headers manually
    if (filename.endsWith('.zip')) {
        res.setHeader('Content-Type', 'application/zip');
    } else if (filename.endsWith('.pdf')) {
        res.setHeader('Content-Type', 'application/pdf');
    } else {
        res.setHeader('Content-Type', 'application/octet-stream');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (err) => {
        console.error('[DOWNLOAD] Erro no stream:', err);
        if (!res.headersSent) res.status(500).send('Erro ao ler arquivo.');
    });

    fileStream.on('end', () => {
        console.log('[DOWNLOAD] Envio concluído.');
    });

    fileStream.pipe(res);

    // Auto-cleanup: Delete file after download completes
    res.on('finish', () => {
        fs.unlink(filePath, (err) => {
            if (err) console.error(`[CLEANUP] Erro ao deletar ${filename}:`, err);
            else console.log(`[CLEANUP] Arquivo removido: ${filename}`);
        });
    });
});

// Ensure output directory exists in /tmp
const OUTPUT_DIR = '/tmp/output';
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function sendProgress(id, message) {
    if (clients.has(id)) {
        clients.get(id).write(`data: ${JSON.stringify({ type: 'progress', message })}\n\n`);
    }
}

function sendComplete(id, downloadUrl, failedFiles = []) {
    if (clients.has(id)) {
        clients.get(id).write(`data: ${JSON.stringify({ type: 'complete', url: downloadUrl, failedFiles })}\n\n`);
    }
}

function sendError(id, message) {
    if (clients.has(id)) {
        clients.get(id).write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }
}

async function performOCR(pdfPath, uploadId, count, total) {
    try {
        console.log(`[OCR] Iniciando OCR para: ${pdfPath}`);
        sendProgress(uploadId, `(${count}/${total}) 🔍 OCR necessário (imagem detectada). Processando...`);

        // Convert only the first page to image to save time/memory
        const pages = await pdfToPng(pdfPath, {
            viewportScale: 3.0, // Better resolution for noisy scans
            pagesToProcess: [1]
        });

        if (pages.length === 0 || !pages[0].content) {
            console.log('[OCR] Nenhuma imagem gerada do PDF');
            return '';
        }

        // Tesseract processes the image buffer
        // Note: cachePath is important for Vercel as root is read-only
        const { data: { text } } = await Tesseract.recognize(
            Buffer.from(pages[0].content),
            'por',
            {
                cachePath: '/tmp/tesseract-cache',
                gzip: false // Faster on some environments
            }
        );

        console.log(`[OCR] Texto extraído (${text.length} chars)`);
        return text;
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

app.post('/upload', upload.array('pdfs'), async (req, res) => {
    const uploadId = req.query.id;

    if (!req.files || req.files.length === 0) {
        return res.status(400).send('Nenhum arquivo enviado.');
    }

    // Do NOT respond immediately on Vercel, must wait for processing to finish
    console.log(`[${uploadId}] Recebidos ${req.files.length} arquivos.`);
    sendProgress(uploadId, `Iniciando processamento de ${req.files.length} arquivos...`);

    const processedFiles = [];
    const failedFiles = [];

    try {
        let count = 0;
        for (const file of req.files) {
            count++;
            console.log(`[LOOP] Processando arquivo ${count}: ${file.originalname}`);

            const dataBuffer = fs.readFileSync(file.path);
            console.log(`[FILE] Li ${dataBuffer.length} bytes.`);

            sendProgress(uploadId, `(${count}/${req.files.length}) Lendo: ${file.originalname}...`);
            console.log(`[PROCESS] Processando: ${file.originalname}`);

            let fullText = '';
            try {
                // Use pdf-parse to extract text
                const data = await pdf(dataBuffer);
                fullText = data.text;

            } catch (err) {
                console.error('[PDF ERROR]', err);
            }

            console.log(`[DEBUG] Texto extraído: ${fullText.length} caracteres.`);

            // Strategy: Find in text, then fallback to OCR
            let code = findTrackingCode(fullText);

            if (!code) {
                const ocrText = await performOCR(file.path, uploadId, count, req.files.length);
                if (ocrText) {
                    code = findTrackingCode(ocrText);
                }
            }

            let filename = file.originalname;
            if (code) {
                filename = `${code}.pdf`;
                sendProgress(uploadId, `(${count}/${req.files.length}) ✅ Encontrado: ${code}`);

                let finalFilename = filename;
                let dupCounter = 1;
                while (processedFiles.some(f => f.filename === finalFilename)) {
                    const ext = path.extname(filename);
                    const name = path.basename(filename, ext);
                    finalFilename = `${name}_(${dupCounter})${ext}`;
                    dupCounter++;
                }

                processedFiles.push({
                    path: file.path,
                    filename: finalFilename
                });

            } else {
                const isScanned = fullText.replace(/\s+/g, '').length < 10;
                let reason = isScanned ? 'Imagem ou texto ilegível' : 'Código não identificado';
                sendProgress(uploadId, `(${count}/${req.files.length}) ❌ ERRO: ${reason}`);

                failedFiles.push({
                    filename: file.originalname,
                    reason: `${reason} (Texto: ${fullText.length} chars)`
                });

                if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            }
        }


        if (processedFiles.length === 0) {
            // Even if 0 processed, send error but with list of failures if available
            if (failedFiles.length > 0) {
                // Return detailed reasons in the error message
                const details = failedFiles.map(f => `${f.filename} (${f.reason})`).join(', ');
                sendError(uploadId, `Falha ao processar arquivos. Detalhes: ${details}`);
            } else {
                sendError(uploadId, 'Nenhum arquivo válido foi processado.');
            }
            cleanup(req.files);
            return;
        }

        sendProgress(uploadId, 'Gerando arquivo final...');

        if (processedFiles.length === 1) {
            // Single file
            const file = processedFiles[0];
            const outputFilename = file.filename;
            const outputPath = path.join(OUTPUT_DIR, outputFilename);

            // Move file to output
            fs.copyFileSync(file.path, outputPath);

            sendProgress(uploadId, 'Pronto! Iniciando download...');
            sendComplete(uploadId, `/download/${outputFilename}`, failedFiles);
            cleanup(req.files);
            res.status(200).json({ success: true, downloadUrl: `/download/${outputFilename}` });

        } else {
            // Multiple files - ZIP
            const outputFilename = `arquivos_renomeados_${Date.now()}.zip`;
            const zipPath = path.join(OUTPUT_DIR, outputFilename);
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            const zipPromise = new Promise((resolve, reject) => {
                output.on('close', function () {
                    sendProgress(uploadId, 'Compactação concluída.');
                    sendComplete(uploadId, `/download/${outputFilename}`, failedFiles);
                    cleanup(req.files);
                    resolve();
                });
                archive.on('error', reject);
            });

            archive.pipe(output);
            for (const file of processedFiles) {
                archive.file(file.path, { name: file.filename });
            }
            archive.finalize();

            await zipPromise;
            res.status(200).json({ success: true, downloadUrl: `/download/${outputFilename}` });
        }

    } catch (error) {
        console.error('SERVER ERROR:', error);
        sendError(uploadId, `Erro interno: ${error.message}`);
        cleanup(req.files);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

function cleanup(files) {
    if (files) {
        files.forEach(file => {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        });
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
