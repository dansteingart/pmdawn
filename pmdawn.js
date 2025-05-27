const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { exec } = require('child_process');
const { start } = require('repl');
const pm2 = require('pm2');


args = process.argv.slice(2);
try {port = args[0]}
catch(e) {port = 3000}

const app = express();
let previousData = []; // Store the previous PM2 data

// Middleware to parse JSON and URL-encoded HTTP requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = socketIO(server);

// Serve static files from the public folder
app.use(express.static('public'));

function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.set('WWW-Authenticate', 'Basic realm="Restricted Area"');
        return res.status(401).send('Authentication required.');
    }
    const token = authHeader.split(' ')[1];
    const credentials = Buffer.from(token, 'base64').toString('utf8').split(':');
    const username = credentials[0];
    const password = credentials[1];
    if (username === 'foofighter' && password === 'm@r1g0ld') {
        return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Restricted Area"');
    return res.status(401).send('Invalid credentials.');
}


// New hello_world route
app.get('/', (req, res) => { res.sendFile('index.html', { root: __dirname  });});



// New /state route to return the results of `pm2 jlist` as JSON
statejson = {}
laststate = 0;

function getState(){
    exec('pm2 jlist', (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
        }
        try {
            statejson = JSON.parse(stdout);
            
        } catch (parseError) {
            console.error(`parse error: ${parseError}`);
        }
    });
}

setInterval(()=>{getState()},1000);
app.get('/state', basicAuth, (req, res) => {res.json(statejson);});



function getPm2Data() {
    return new Promise((resolve, reject) => {
        pm2.connect((err) => {
            if (err) {
                console.error(err);
                reject(err);
                return;
            }

            pm2.list((err, processList) => {
                pm2.disconnect();
                if (err) {
                    console.error(err);
                    reject(err);
                    return;
                }
                resolve(processList);
            });
        });
    });
}

function diffPm2Data(currentData, previousData) {
    const updates = [];

    // Identify new processes
    currentData.forEach(currentProcess => {
        const existingProcess = previousData.find(p => p.pm_id === currentProcess.pm_id);
        if (!existingProcess) {
            updates.push({ type: 'add', data: currentProcess });
        }
    });

    // Identify updated processes
    currentData.forEach(currentProcess => {
        const existingProcess = previousData.find(p => p.pm_id === currentProcess.pm_id);
        if (existingProcess) {
            // Compare relevant properties to detect changes (e.g., status, cpu, memory)
            if (existingProcess.pm2_env.status !== currentProcess.pm2_env.status ||
                existingProcess.monit.cpu !== currentProcess.monit.cpu ||
                existingProcess.monit.memory !== currentProcess.monit.memory) {
                updates.push({ type: 'update', data: currentProcess });
            }
        }
    });

    // Identify removed processes
    previousData.forEach(previousProcess => {
        const existingProcess = currentData.find(p => p.pm_id === previousProcess.pm_id);
        if (!existingProcess) {
            updates.push({ type: 'remove', data: { pm_id: previousProcess.pm_id } });
        }
    });

    return updates;
}

function startSocketServer() {

    io.on('connection', (socket) => {
        console.log('Client connected');
    exec('pm2 jlist', (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }
        try {
            const currentData = JSON.parse(stdout);
            const updates = currentData.map(processData => {
                return { type: 'add', data: processData };
            });
            socket.emit('pm2-updates', updates);
        } catch (parseError) {
            console.error(`parse error: ${parseError}`);
        }
    });

        // Function to send PM2 data updates
        const sendPm2Updates = async () => {
            try {
                const currentData = await getPm2Data();
                const updates = diffPm2Data(currentData, previousData);

                if (updates.length > 0) {
                    socket.emit('pm2-updates', updates);
                }

                previousData = currentData; // Update previous data for next diff

            } catch (error) {
                console.error('Error fetching or sending PM2 data:', error);
            }
        };

        // Initial data load and periodic updates
        sendPm2Updates();
        const intervalId = setInterval(sendPm2Updates, 500); // Every 5 seconds

        socket.on('disconnect', () => {
            console.log('Client disconnected');
            clearInterval(intervalId); // Clear the interval when the client disconnects
        });
    });
}


startSocketServer();

server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});