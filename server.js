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
            viewportScale: 2.0, // Good resolution for OCR
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

app.post('/upload', upload.array('pdfs'), async (req, res) => {
    const uploadId = req.query.id;

    if (!req.files || req.files.length === 0) {
        return res.status(400).send('Nenhum arquivo enviado.');
    }

    // Respond immediately so browser knows upload is done sending
    res.status(200).send('Upload received, processing...');

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

            // Clean text check
            const cleanText = fullText.replace(/\s+/g, '').trim();
            const isScanned = cleanText.length < 10;

            // Define Regex strategies
            // Improved Regex: Allows whitespace between letters and digits
            // Tracking code is [2 chars] [9 digits] [2 chars]
            const regexContext = /(?:OBJETO)?\s*\(RASTREAMENTO\)\s*:\s*(?:Correios\s*)?([A-Z]{2}\s*(?:\d\s*){9}[A-Z]{2})/i;
            const regexFallback = /([A-Z]{2})\s*((?:\d\s*){9})\s*([A-Z]{2})/i;
            const regexFuzzy = /([A-Z]{2})\s*([0-9OSZBIgl\s]{9,18})\s*([A-Z]{2})/i;
            const regexLoose = /([A-Z]\s*[A-Z])\s*((?:\d\s*){9,15})\s*([A-Z]\s*[A-Z])/i;

            let match = fullText.match(regexContext);
            let code = null;

            if (match && match[1]) {
                code = match[1].replace(/\s+/g, '').toUpperCase();
                console.log(`[MATCH] Contexto estrito encontrou: ${code}`);
            }

            // If the strict context match failed, try the fallback (search anywhere)
            if (!code) {
                const matchFallback = fullText.match(regexFallback);
                if (matchFallback) {
                    code = `${matchFallback[1]}${matchFallback[2].replace(/\s+/g, '')}${matchFallback[3]}`.toUpperCase();
                    sendProgress(uploadId, `(${count}/${req.files.length}) ℹ️ Código detectado (Fallback): ${code}`);
                    console.log(`[MATCH] Fallback encontrou: ${code}`);
                }
                if (!code) {
                    const matchLoose = fullText.match(regexLoose);
                    if (matchLoose) {
                        code = (matchLoose[1] + matchLoose[2] + matchLoose[3]).replace(/\s+/g, '').toUpperCase();
                        console.log(`[MATCH] Loose encontrou: ${code}`);
                    }
                }
            }

            // MegaClean strategy: Remove ALL whitespace and search
            if (!code) {
                const megaClean = fullText.replace(/\s+/g, '').toUpperCase();
                const megaMatch = megaClean.match(/[A-Z]{2}\d{9}[A-Z]{2}/);
                if (megaMatch) {
                    code = megaMatch[0];
                    console.log(`[MATCH] MegaClean encontrou: ${code}`);
                }
            }

            // If normal extraction failed, try OCR
            if (!code) {
                const ocrText = await performOCR(file.path, uploadId, count, req.files.length);
                if (ocrText && ocrText.length > 10) {
                    fullText = ocrText;

                    // Re-run the regex checks on OCR text
                    match = fullText.match(regexContext);
                    if (match && match[1]) {
                        code = match[1].replace(/\s+/g, '').toUpperCase();
                        console.log(`[MATCH-OCR] Contexto estrito encontrou: ${code}`);
                    }

                    if (!code) {
                        const matchFallback = fullText.match(regexFallback);
                        if (matchFallback) {
                            code = `${matchFallback[1]}${matchFallback[2].replace(/\s+/g, '')}${matchFallback[3]}`.toUpperCase();
                            console.log(`[MATCH-OCR] Fallback encontrou: ${code}`);
                        }
                    }

                    if (!code) {
                        const matchFuzzy = fullText.match(regexFuzzy);
                        if (matchFuzzy) {
                            const prefix = matchFuzzy[1].toUpperCase();
                            const suffix = matchFuzzy[3].toUpperCase();
                            let cleanDigits = matchFuzzy[2].toUpperCase()
                                .replace(/\s+/g, '')
                                .replace(/O/g, '0').replace(/S/g, '5').replace(/Z/g, '2')
                                .replace(/I/g, '1').replace(/L/g, '1').replace(/B/g, '8').replace(/G/g, '6');

                            if (/^\d{9}$/.test(cleanDigits)) {
                                code = `${prefix}${cleanDigits}${suffix}`;
                                console.log(`[MATCH-OCR] Fuzzy encontrou: ${code}`);
                            }
                        }
                    }

                    if (!code) {
                        const megaClean = fullText.replace(/\s+/g, '').toUpperCase();
                        const megaMatch = megaClean.match(/[A-Z]{2}\d{9}[A-Z]{2}/);
                        if (megaMatch) {
                            code = megaMatch[0];
                            console.log(`[MATCH-OCR] MegaClean encontrou: ${code}`);
                        }
                    }
                }
            }

            // Strategy 3: Fuzzy Match (Handle common typos even in digital text: S=5, O=0, etc.)
            if (!code) {
                const matchFuzzy = fullText.match(regexFuzzy);

                if (matchFuzzy) {
                    const prefix = matchFuzzy[1].toUpperCase();
                    const suffix = matchFuzzy[3].toUpperCase();
                    let rawDigits = matchFuzzy[2].toUpperCase();

                    // Normalize digits
                    const cleanDigits = rawDigits
                        .replace(/\s+/g, '') // Remove spaces
                        .replace(/O/g, '0')
                        .replace(/S/g, '5')
                        .replace(/Z/g, '2')
                        .replace(/I/g, '1')
                        .replace(/L/g, '1')
                        .replace(/B/g, '8')
                        .replace(/G/g, '6');

                    if (/^\d{9}$/.test(cleanDigits)) {
                        code = `${prefix}${cleanDigits}${suffix}`;
                        sendProgress(uploadId, `(${count}/${req.files.length}) 🔧 Código corrigido (Fuzzy): ${code}`);
                    }
                }
            }

            let filename = file.originalname;
            if (code) {
                filename = `${code}.pdf`;
                if (match) sendProgress(uploadId, `(${count}/${req.files.length}) Código encontrado: ${code}`);

                // Handle Duplicate Filenames
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
                let reason = 'Código não encontrado';
                if (isScanned) {
                    reason = `IMAGEM ou Texto ilegível (Extracted: ${fullText.length} chars)`;
                    sendProgress(uploadId, `(${count}/${req.files.length}) ❌ ERRO: ${reason}`);
                } else {
                    reason = `Código não encontrado (Texto: ${fullText.length} chars)`;
                    sendProgress(uploadId, `(${count}/${req.files.length}) ❌ ERRO: ${reason}`);
                }

                failedFiles.push({
                    filename: file.originalname,
                    reason: reason
                });

                // Delete failed file immediately
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
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

        } else {
            // Multiple files - ZIP
            const outputFilename = `arquivos_renomeados_${Date.now()}.zip`;
            const zipPath = path.join(OUTPUT_DIR, outputFilename);
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', function () {
                sendProgress(uploadId, 'Compactação concluída.');
                sendComplete(uploadId, `/download/${outputFilename}`, failedFiles);
                cleanup(req.files);
            });

            archive.on('error', function (err) {
                throw err;
            });

            archive.pipe(output);

            for (const file of processedFiles) {
                archive.file(file.path, { name: file.filename });
            }

            archive.finalize();
        }

    } catch (error) {
        console.error('SERVER ERROR:', error);
        sendError(uploadId, `Erro interno: ${error.message}`);
        cleanup(req.files);
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
