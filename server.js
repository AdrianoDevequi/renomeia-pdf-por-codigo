const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
// Use legacy build for Node.js CommonJS compatibility
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

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
                // Convert Buffer to Uint8Array
                const uint8Data = new Uint8Array(dataBuffer);

                // Load PDF document
                // Remove explicit font path, rely on default or internal resolution
                const loadingTask = pdfjsLib.getDocument({
                    data: uint8Data,
                    // standardFontDataUrl: ... // Removing this as it might be wrong in Vercel
                });

                const doc = await loadingTask.promise;

                // Iterate over all pages
                const numPages = doc.numPages;
                for (let i = 1; i <= numPages; i++) {
                    const page = await doc.getPage(i);
                    const content = await page.getTextContent();

                    const strings = content.items.map(item => item.str);
                    fullText += strings.join(' ') + '\n';
                }

            } catch (err) {
                console.error('[PDF ERROR]', err);
            }

            console.log(`[DEBUG] Texto extraído: ${fullText.length} caracteres.`);

            // Clean text check
            const cleanText = fullText.replace(/\s+/g, '').trim();
            const isScanned = cleanText.length < 10;

            // Regex 1: Context-aware
            // Modified to be less greedy and handle newlines/words like "Correios"
            // Looks for (RASTREAMENTO) ... then explicitly looks for the code pattern
            const regexContext = /(?:OBJETO)?\s*\(RASTREAMENTO\)\s*:\s*(?:Correios\s*)?([A-Z]{2}\s*\d{9}\s*[A-Z]{2})/i;
            let match = fullText.match(regexContext);
            let code = null;

            if (match && match[1]) {
                code = match[1].replace(/\s+/g, '').toUpperCase();
                console.log(`[MATCH] Contexto estrito encontrou: ${code}`);
            }

            // If the strict context match failed, try the fallback (search anywhere)
            if (!code) {
                // Regex 2: Fallback - Permissive
                const regexFallback = /([A-Z]{2})\s*(\d{9})\s*([A-Z]{2})/i;
                const matchFallback = fullText.match(regexFallback);
                if (matchFallback) {
                    code = `${matchFallback[1]}${matchFallback[2]}${matchFallback[3]}`.toUpperCase();
                    sendProgress(uploadId, `(${count}/${req.files.length}) ℹ️ Código detectado (Fallback): ${code}`);
                    console.log(`[MATCH] Fallback encontrou: ${code}`);
                }
            }

            // Strategy 3: Fuzzy Match (Handle common typos even in digital text: S=5, O=0, etc.)
            if (!code) {
                // Looks for: 2 letters, 9 chars (digits or lookalikes), 2 letters
                const regexFuzzy = /([A-Z]{2})\s*([0-9OSZBIgl]{9})\s*([A-Z]{2})/i;
                const matchFuzzy = fullText.match(regexFuzzy);

                if (matchFuzzy) {
                    const prefix = matchFuzzy[1].toUpperCase();
                    const suffix = matchFuzzy[3].toUpperCase();
                    let rawDigits = matchFuzzy[2].toUpperCase();

                    // Normalize digits
                    const cleanDigits = rawDigits
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
