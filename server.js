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
