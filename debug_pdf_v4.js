const pdfLib = require('pdf-parse');
let PF = pdfLib.PDFParse || pdfLib;

async function run() {
    try {
        console.log('Instantiating PDFParse...');
        const buff = Buffer.from('test pdf content'); // This probably won't work as real PDF, but maybe we can see the structure
        // If it needs a real PDF, it might fail parsing, but let's see the object structure at least.
        // Actually, let's try to just inspect the prototype or static methods if instantiation fails.
    } catch (e) { }

    // Let's create a dummy valid PDF buffer if possible, or just see if we can find documentation/properties
    // Since I can't easily create a valid PDF here without another lib, I'll rely on inspecting the class.

    console.log('Prototype keys:', Object.getOwnPropertyNames(PF.prototype));

    try {
        // We can try to use a real file from the uploads folder if one exists, but I don't know the filenames for sure.
        // Let's just try to instantiate with empty buffer.
        const instance = new PF(Buffer.from(''));
        console.log('Instance keys:', Object.keys(instance));
        console.log('Instance prototype:', Object.getPrototypeOf(instance));

        // Maybe it has a .text property?
        if (instance.text !== undefined) console.log('Has .text property');

        // Maybe it returns a promise on some method?
    } catch (e) {
        console.log('Instantiation error:', e.message);
    }
}

run();
