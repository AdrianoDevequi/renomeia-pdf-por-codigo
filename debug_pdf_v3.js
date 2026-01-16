const pdfLib = require('pdf-parse');
let PF = pdfLib.PDFParse || pdfLib;

console.log('Testing PDFParse invocation...');

if (typeof PF === 'function') {
    try {
        console.log('Trying as function...');
        // Just mocking a buffer-like object or using empty buffer
        const buff = Buffer.from('test');
        const res = PF(buff);
        console.log('Function call success:', typeof res);
    } catch (e) {
        console.log('Function call failed:', e.message);
    }

    try {
        console.log('Trying with new...');
        const buff = Buffer.from('test');
        const instance = new PF(buff);
        console.log('Instantiation success. Properties:', Object.keys(instance));
    } catch (e) {
        console.log('Instantiation failed:', e.message);
    }
} else {
    console.log('PF is not a function/class:', typeof PF);
}
