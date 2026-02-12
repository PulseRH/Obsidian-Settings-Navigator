// Wrapper script to monitor TypeScript compilation and log what's happening
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '.cursor', 'debug.log');
const SERVER_ENDPOINT = 'http://127.0.0.1:7244/ingest/1163e1f9-5b04-46b2-9013-44e33e9d5de9';

function log(entry) {
	const logLine = JSON.stringify({
		...entry,
		timestamp: Date.now(),
		sessionId: 'debug-session',
		runId: process.env.RUN_ID || 'run1'
	}) + '\n';
	
	try {
		fs.appendFileSync(LOG_PATH, logLine, 'utf8');
	} catch (err) {
		console.error('Failed to write log:', err);
	}
	
	// Also try HTTP
	const http = require('http');
	const url = require('url');
	const parsedUrl = url.parse(SERVER_ENDPOINT);
	const postData = JSON.stringify(entry);
	const options = {
		hostname: parsedUrl.hostname,
		port: parsedUrl.port,
		path: parsedUrl.path,
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
	};
	const req = http.request(options, () => {}).on('error', () => {});
	req.write(postData);
	req.end();
}

const args = process.argv.slice(2);

log({
	location: 'tsc-wrapper.js:start',
	message: 'TypeScript wrapper started',
	data: { args, nodeVersion: process.version, cwd: process.cwd() },
	hypothesisId: 'A'
});

// Check if tsconfig.json exists
const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
if (fs.existsSync(tsconfigPath)) {
	const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
	log({
		location: 'tsc-wrapper.js:tsconfig',
		message: 'tsconfig.json loaded',
		data: { 
			include: tsconfig.include,
			exclude: tsconfig.exclude,
			compilerOptions: Object.keys(tsconfig.compilerOptions || {})
		},
		hypothesisId: 'B'
	});
}

const tscProcess = spawn('tsc', args, {
	stdio: ['inherit', 'pipe', 'pipe'],
	shell: true
});

let stdout = '';
let stderr = '';
let startTime = Date.now();

tscProcess.stdout.on('data', (data) => {
	const chunk = data.toString();
	stdout += chunk;
	log({
		location: 'tsc-wrapper.js:stdout',
		message: 'tsc stdout chunk',
		data: { 
			chunkLength: chunk.length, 
			totalStdoutLength: stdout.length,
			elapsedMs: Date.now() - startTime
		},
		hypothesisId: 'C'
	});
	process.stdout.write(data);
});

tscProcess.stderr.on('data', (data) => {
	const chunk = data.toString();
	stderr += chunk;
	log({
		location: 'tsc-wrapper.js:stderr',
		message: 'tsc stderr chunk',
		data: { 
			chunkLength: chunk.length, 
			totalStderrLength: stderr.length,
			elapsedMs: Date.now() - startTime
		},
		hypothesisId: 'D'
	});
	process.stderr.write(data);
});

tscProcess.on('spawn', () => {
	log({
		location: 'tsc-wrapper.js:spawn',
		message: 'tsc process spawned',
		data: { pid: tscProcess.pid },
		hypothesisId: 'A'
	});
});

tscProcess.on('error', (error) => {
	log({
		location: 'tsc-wrapper.js:error',
		message: 'tsc process error',
		data: { error: error.message, code: error.code },
		hypothesisId: 'E'
	});
});

tscProcess.on('exit', (code, signal) => {
	const elapsed = Date.now() - startTime;
	log({
		location: 'tsc-wrapper.js:exit',
		message: 'tsc process exited',
		data: { 
			code, 
			signal, 
			stdoutLength: stdout.length, 
			stderrLength: stderr.length,
			elapsedMs: elapsed
		},
		hypothesisId: 'F'
	});
	process.exit(code || 0);
});

// Monitor memory usage
const memoryInterval = setInterval(() => {
	const memUsage = process.memoryUsage();
	log({
		location: 'tsc-wrapper.js:memory',
		message: 'memory usage check',
		data: {
			rss: Math.round(memUsage.rss / 1024 / 1024),
			heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
			heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
			elapsedMs: Date.now() - startTime
		},
		hypothesisId: 'G'
	});
}, 2000);

tscProcess.on('exit', () => {
	clearInterval(memoryInterval);
});


