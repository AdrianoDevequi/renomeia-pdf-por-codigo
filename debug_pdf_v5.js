const pdfLib = require('pdf-parse');
let PF = pdfLib.PDFParse || pdfLib;

async function run() {
    try {
        console.log('Testing getText...');
        // Create a minimal PDF buffer or just handle error
        const parser = new PF(Buffer.from('dummy'));
        // Mocking DOC because real parsing might fail on dummy buffer
        // But let's see if we can call getText. It might throw "Invalid PDF"
        // If it throws, we assume usage is `await parser.getText()`

        console.log('Calling getText()...');
        const result = await parser.getText();
        console.log('Result Type:', typeof result);
        console.log('Result keys:', Object.keys(result || {}));
    } catch (e) {
        console.log('Error calling getText:', e.message);
        console.log('Error stack:', e.stack);
    }
}
run();
