const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packagedBinary = path.join(projectRoot, 'dist', 'linux-unpacked', 'atlas-desk');
const binary = process.env.ATLAS_ELECTRON_BINARY || packagedBinary;

if (!fs.existsSync(binary)) {
  throw new Error(`Electron binary not found at ${binary}. Run npm run package:dir first.`);
}

const launchArguments = [
  ...(binary.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []),
  '--no-sandbox',
  '--ozone-platform=headless',
  '--disable-gpu'
];

const child = spawn(binary, launchArguments, {
  cwd: projectRoot,
  env: {
    ...process.env,
    ATLAS_ELECTRON_SMOKE: '1',
    ATLAS_CDP_PORT: '9340',
    ELECTRON_ENABLE_LOGGING: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
}, 20000);

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});

child.on('close', (code) => {
  clearTimeout(timeout);
  const marker = output.split(/\r?\n/).find((line) => line.startsWith('ATLAS_ELECTRON_SMOKE:'));
  if (code !== 0 || !marker?.includes('"passed":true')) {
    console.error(output.trim());
    process.exitCode = 1;
    return;
  }
  console.log(marker.slice('ATLAS_ELECTRON_SMOKE:'.length));
});
