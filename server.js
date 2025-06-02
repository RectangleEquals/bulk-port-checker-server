//
// server.js
//
// Bulk Open‐Port Scanner (WebSocket + TCP ping) for Render.com deployment.
// Exposes an HTTP endpoint (POST /scan) to begin scanning [startPort..endPort] on a connected client.
// Communicates via WebSocket to instruct the client to start a TCP listener on each port,
// then attempts a net.connect() back to the client’s public IP.
//
// To deploy on Render.com, make sure your service’s Start Command is “npm start”
// and set the Environment “PORT” to use process.env.PORT (Render auto-injects it).
//

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
let connectedClient = null;
let clientPublicIp = null;

// In‐progress scan state:
let isScanning = false;
let scanQueue = [];
let scanResults = [];

/**
 * Broadcast a JSON‐serializable message to the single connected client.
 * (In this implementation, we assume exactly one client.)
 */
function sendToClient(msgObj) {
    if (connectedClient && connectedClient.readyState === WebSocket.OPEN) {
        connectedClient.send(JSON.stringify(msgObj));
    }
}

/**
 * Given a port, attempt to connect to the client's public IP.
 * Returns a Promise that resolves with { port, success, errorMessage? }.
 */
function attemptConnectToClient(port) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let settled = false;

        // If connection succeeds:
        socket.once('connect', () => {
            settled = true;
            socket.destroy();
            resolve({ port, success: true });
        });

        // On error (timeout, refuse, etc.)
        socket.once('error', err => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve({ port, success: false, errorMessage: err.message });
            }
        });

        // Add a timeout (e.g. 2 seconds)
        socket.setTimeout(2000, () => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve({ port, success: false, errorMessage: 'timeout' });
            }
        });

        // Kick off the connect attempt
        socket.connect(port, clientPublicIp);
    });
}

/**
 * Processes the next port in the scanQueue (if any).
 * This function is recursive/iterative until the queue is empty.
 */
async function processNextPort() {
    if (scanQueue.length === 0) {
        console.log('▶️  Scan complete.');
        isScanning = false;
        // Optionally: send final results back to client
        sendToClient({ event: 'scanComplete', results: scanResults });
        return;
    }

    const port = scanQueue.shift();
    console.log(`\n➡️  [${port}] Asking client to listen on port ${port}...`);
    scanResults.push({ port, status: 'pending' });

    // 1. Instruct client to start listening:
    sendToClient({ command: 'startListener', port });

    // Wait until client confirms it is listening on that port:
    await new Promise(resolve => {
        const onClientMsg = msgJSON => {
            let msg;
            try {
                msg = JSON.parse(msgJSON);
            } catch (e) {
                return;
            }
            if (msg.event === 'listening' && msg.port === port) {
                connectedClient.removeListener('message', onClientMsg);
                resolve();
            } else if (msg.event === 'error' && msg.port === port) {
                connectedClient.removeListener('message', onClientMsg);
                resolve();
            }
        };
        connectedClient.on('message', onClientMsg);
    });

    console.log(
        `   ✅ Client is now listening on port ${port}. Attempting TCP connect...`
    );

    // 2. Attempt to connect to clientPublicIp:port
    const result = await attemptConnectToClient(port);
    const idx = scanResults.findIndex(r => r.port === port);

    if (result.success) {
        console.log(`   🟢 Port ${port} is OPEN (connection succeeded).`);
        scanResults[idx].status = 'open';
    } else {
        console.log(
            `   🔴 Port ${port} is CLOSED (cause: ${result.errorMessage}).`
        );
        scanResults[idx].status = 'closed';
        scanResults[idx].error = result.errorMessage;
    }

    // 3. Tell client to shut down listener on that port:
    sendToClient({ command: 'stopListener', port });

    // 4. Send an intermediate progress update to client (optional)
    sendToClient({
        event: 'portScanned',
        port,
        success: result.success,
        error: result.errorMessage || null,
        remaining: scanQueue.length,
    });

    // 5. Recurse to next port (slight delay to avoid blasting):
    setTimeout(processNextPort, 100);
}

/**
 * HTTP endpoint to trigger a new scan:
 * POST /scan
 * Body JSON: { "startPort": 8000, "endPort": 8010 }
 */
app.post('/scan', (req, res) => {
    if (!connectedClient) {
        return res
            .status(400)
            .json({ error: 'No client connected via WebSocket.' });
    }
    if (isScanning) {
        return res
            .status(400)
            .json({ error: 'A scan is already in progress.' });
    }

    const { startPort, endPort } = req.body;
    if (
        typeof startPort !== 'number' ||
        typeof endPort !== 'number' ||
        startPort < 1 ||
        endPort < startPort
    ) {
        return res.status(400).json({ error: 'Invalid port range.' });
    }

    // Build the scan queue:
    scanQueue = [];
    for (let p = startPort; p <= endPort; p++) {
        scanQueue.push(p);
    }
    scanResults = [];
    isScanning = true;

    console.log(
        `\n📡 Starting scan on ${clientPublicIp} from port ${startPort} to ${endPort}...`
    );
    sendToClient({ event: 'scanStarted', startPort, endPort });

    // Kick off the first iteration
    processNextPort();

    res.json({ message: 'Scan started', total: scanQueue.length });
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`🚀 Server listening on port ${process.env.PORT || 3000}`);
});

/**
 * WebSocket connection handling
 */
wss.on('connection', (ws, req) => {
    console.log('🔗 New WebSocket connection established.');

    // 1) Read X-Forwarded-For (if present). Fallback to req.socket.remoteAddress.
    let forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        // It might look like "203.0.113.25, 10.0.0.5, ::1"
        clientPublicIp = forwarded.split(',')[0].trim();
    } else {
        // Fallback: might be "::ffff:203.0.113.25" or "::1"
        clientPublicIp = (req.socket.remoteAddress || '').replace(
            /^::ffff:/,
            ''
        );
    }

    // At this point, `clientPublicIp` should be your real public IP
    console.log(`   Client’s public IP is ${clientPublicIp}`);

    // Store ws so that `scan` endpoint can use it
    connectedClient = ws;

    // Send handshake back to client
    ws.send(JSON.stringify({ event: 'welcome', publicIp: clientPublicIp }));

    ws.on('message', raw => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            return;
        }
        if (msg.event === 'error' && msg.port) {
            console.log(
                `   ❗ Client reported error on port ${msg.port}: ${msg.error}`
            );
        }
    });

    ws.on('close', () => {
        console.log('❌ WebSocket connection closed.');
        connectedClient = null;
        clientPublicIp = null;
        isScanning = false;
        scanQueue = [];
    });

    ws.on('error', err => {
        console.error('WebSocket error:', err);
    });
});
