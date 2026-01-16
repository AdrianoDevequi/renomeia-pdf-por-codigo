const pdf = require('pdf-parse');
console.log('Type:', typeof pdf);
console.log('Keys:', Object.keys(pdf));
console.log('Is Default Function?', typeof pdf.default);
console.log('Is PDFParse Function?', typeof pdf.PDFParse);
