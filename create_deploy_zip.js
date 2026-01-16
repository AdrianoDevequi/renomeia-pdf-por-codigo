const fs = require('fs');
const archiver = require('archiver');
const output = fs.createWriteStream('deploy_renomeia_pdf.zip');
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', function () {
    console.log('Zip criado com sucesso: deploy_renomeia_pdf.zip (' + archive.pointer() + ' bytes)');
});

archive.on('error', function (err) {
    throw err;
});

archive.pipe(output);

// Adicionar arquivos
archive.file('server.js', { name: 'server.js' });
archive.file('package.json', { name: 'package.json' });

// Adicionar pasta public
archive.directory('public/', 'public');

archive.finalize();
