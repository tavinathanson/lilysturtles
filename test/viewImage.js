#!/usr/bin/env node
const processImage = require('../lib/processImage');
const fs = require('fs');
const { execSync } = require('child_process');

const input = process.argv[2] || 'test/test_photo.jpg';
const outPath = '/tmp/turtle_preview.png';

(async () => {
  const buf = fs.readFileSync(input);
  const result = await processImage(buf);
  const base64 = result.imageData.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
  console.log('shellDetected:', result.shellDetected);
  console.log('hint:', result.hint);
  console.log('Written to', outPath);
  execSync(`open "${outPath}"`);
})();
