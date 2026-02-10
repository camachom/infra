import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb"

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE_NAME = process.env.DYNAMODB_TABLE
const API_ENDPOINT = process.env.API_ENDPOINT

export const handler = async (event) => {
    const path = event?.requestContext?.http?.path

    switch (path) {
        case "/":
            return { statusCode: 302, headers: { Location: "/demo" } }
        case "/demo":
            return serveDemoPage()
        case "/dashboard":
            return serveDashboardPage()
        case "/api/stats":
            return await serveStats()
        default:
            return { statusCode: 404, body: "Not found" }
    }
}

async function serveStats() {
    const results = await Promise.all([
        dynamodb.send(
            new GetCommand({
                TableName: TABLE_NAME,
                Key: {
                    PK: "COUNTER#daily",
                    SK: new Date().toISOString().split("T").at(0)
                },
                ConsistentRead: true,
            })
        ),
        dynamodb.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "#PK = :counter_page",
                ExpressionAttributeNames: { "#PK": "PK" },
                ExpressionAttributeValues: { ":counter_page": "COUNTER#page"},
            })
        ),
        dynamodb.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "#PK = :recent_events",
                ExpressionAttributeNames: { "#PK": "PK" },
                ExpressionAttributeValues: { ":recent_events": "EVENT#recent"},
                ScanIndexForward: false,
                Limit: 10,
            })
        )
    ])

    const topPages = (results[1].Items ?? [])
        .sort((a,b) => (b.count ?? 0) - (a.count ?? 0))
        .slice(0, 5)

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            dailyCount: results[0].Item?.count ?? 0,
            recentEvents: results[2].Items ?? [],
            topPages,
        })
    }
}

function serveDemoPage() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tracking Pixel Demo</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #fafafa;
            color: #333;
            min-height: 100vh;
            padding: 2rem;
        }
        .container { max-width: 700px; margin: 0 auto; }
        h1 { font-size: 2rem; margin-bottom: 0.25rem; }
        .subtitle { color: #666; margin-bottom: 2rem; }
        .card {
            background: #fff;
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .card h2 { font-size: 1rem; color: #666; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.5px; }
        .pixel-demo {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 1rem;
            background: #f5f5f5;
            border-radius: 6px;
            margin-bottom: 1rem;
        }
        .pixel-box {
            width: 48px;
            height: 48px;
            border: 2px dashed #999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.7rem;
            color: #666;
        }
        button {
            background: #111;
            color: #fff;
            border: none;
            padding: 0.6rem 1.2rem;
            border-radius: 6px;
            font-size: 0.9rem;
            cursor: pointer;
            transition: background 0.2s;
        }
        button:hover { background: #333; }
        .event-log {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.8rem;
            background: #f5f5f5;
            padding: 1rem;
            border-radius: 6px;
            max-height: 150px;
            overflow-y: auto;
        }
        .event-log .entry { padding: 0.25rem 0; border-bottom: 1px solid #e5e5e5; color: #333; }
        .counter { font-size: 3.5rem; font-weight: 700; color: #111; }
        .live { display: inline-flex; align-items: center; gap: 0.5rem; color: #22c55e; font-size: 0.8rem; }
        .live-dot { width: 6px; height: 6px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        a { color: #111; }
        code { background: #f0f0f0; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.85rem; }
        .muted { color: #999; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Tracking Pixel</h1>
        <p class="subtitle">Serverless event tracking with Lambda, Firehose, DynamoDB, and S3</p>

        <div class="card">
            <h2>Tracking Pixel</h2>
            <div class="pixel-demo">
                <div class="pixel-box">
                    <img src="${API_ENDPOINT}/p.gif?page=demo" width="1" height="1" id="pixel" />
                    1x1
                </div>
                <p>This transparent GIF triggers an event on load.</p>
            </div>
            <button onclick="reloadPixel()">Reload Pixel</button>
            <span class="muted" style="margin-left: 0.75rem;" id="pixelCount">Loaded 1x</span>
        </div>

        <div class="card">
            <h2>Custom Event</h2>
            <p style="margin-bottom: 1rem;">POST JSON to <code>/e</code></p>
            <button onclick="fireEvent()">Fire Event</button>
            <div class="event-log" id="eventLog" style="margin-top: 1rem;">
                <div class="entry muted">Events will appear here...</div>
            </div>
        </div>

        <div class="card">
            <h2>Requests Today</h2>
            <span class="live"><span class="live-dot"></span> Live</span>
            <div class="counter" id="todayCount">-</div>
        </div>

        <div class="card">
            <h2>How It Works</h2>
            <p style="line-height: 1.7;">
                <strong>Ingest:</strong> API Gateway → Lambda → Firehose + DynamoDB<br>
                <strong>Storage:</strong> S3 (gzipped, partitioned by hour)<br>
                <strong>Real-time:</strong> DynamoDB atomic counters<br>
            </p>
            <p style="margin-top: 1rem;"><a href="/dashboard">View Dashboard →</a></p>
        </div>
    </div>

    <script>
        let pixelCount = 1;
        const log = document.getElementById('eventLog');

        function reloadPixel() {
            document.getElementById('pixel').src = '${API_ENDPOINT}/p.gif?page=demo&t=' + Date.now();
            document.getElementById('pixelCount').textContent = 'Loaded ' + (++pixelCount) + 'x';
            addLog('Pixel reloaded');
        }

        async function fireEvent() {
            const payload = { action: 'button_click', ts: new Date().toISOString() };
            try {
                await fetch('${API_ENDPOINT}/e', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                addLog('Event sent: ' + JSON.stringify(payload));
            } catch (e) {
                addLog('Error: ' + e.message);
            }
        }

        function addLog(msg) {
            if (log.querySelector('.muted')) log.innerHTML = '';
            const el = document.createElement('div');
            el.className = 'entry';
            el.textContent = new Date().toLocaleTimeString() + ' - ' + msg;
            log.insertBefore(el, log.firstChild);
        }

        async function poll() {
            try {
                const r = await fetch('/api/stats');
                const d = await r.json();
                document.getElementById('todayCount').textContent = d.dailyCount.toLocaleString();
            } catch (e) {}
        }
        poll();
        setInterval(poll, 5000);
    </script>
</body>
</html>`;

    return {
        statusCode: 200,
        headers: { "Content-Type": "text/html" },
        body: html
    }
}

function serveDashboardPage() {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #fafafa;
            color: #333;
            min-height: 100vh;
            padding: 2rem;
        }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }
        .card {
            background: #fff;
            border-radius: 8px;
            padding: 1.5rem;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .card h2 { font-size: 0.85rem; color: #666; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
        .big { font-size: 3rem; font-weight: 700; }
        .live { display: inline-flex; align-items: center; gap: 0.5rem; color: #22c55e; font-size: 0.75rem; margin-bottom: 1rem; }
        .live-dot { width: 6px; height: 6px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #eee; }
        th { color: #999; font-weight: 500; }
        .bar { height: 6px; background: #111; border-radius: 3px; }
        .muted { color: #999; }
        a { color: #111; }
        .full { grid-column: 1 / -1; }
        .truncate { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Dashboard</h1>
        <div class="live"><span class="live-dot"></span> Updates every 5s</div>

        <div class="grid">
            <div class="card">
                <h2>Today</h2>
                <div class="big" id="todayCount">-</div>
            </div>

            <div class="card">
                <h2>Top Pages</h2>
                <table>
                    <thead><tr><th>Page</th><th>Count</th><th></th></tr></thead>
                    <tbody id="topPages"><tr><td colspan="3" class="muted">Loading...</td></tr></tbody>
                </table>
            </div>

            <div class="card full">
                <h2>Recent Events</h2>
                <table>
                    <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Referer</th></tr></thead>
                    <tbody id="recentEvents"><tr><td colspan="4" class="muted">Loading...</td></tr></tbody>
                </table>
            </div>
        </div>

        <p style="margin-top: 2rem;"><a href="/demo">← Back to Demo</a></p>
    </div>

    <script>
        async function poll() {
            try {
                const r = await fetch('/api/stats');
                const d = await r.json();

                document.getElementById('todayCount').textContent = d.dailyCount.toLocaleString();

                const max = Math.max(...d.topPages.map(p => p.count || 0), 1);
                document.getElementById('topPages').innerHTML = d.topPages.length
                    ? d.topPages.map(p =>
                        '<tr><td class="truncate">' + (p.SK || '-') + '</td><td>' + (p.count || 0) + '</td><td style="width:60px"><div class="bar" style="width:' + ((p.count||0)/max*100) + '%"></div></td></tr>'
                    ).join('')
                    : '<tr><td colspan="3" class="muted">No data</td></tr>';

                document.getElementById('recentEvents').innerHTML = d.recentEvents.length
                    ? d.recentEvents.map(e =>
                        '<tr><td>' + new Date(e.ts).toLocaleTimeString() + '</td><td>' + (e.method || '-') + '</td><td>' + (e.path || '-') + '</td><td class="truncate">' + (e.referer || '-') + '</td></tr>'
                    ).join('')
                    : '<tr><td colspan="4" class="muted">No events</td></tr>';
            } catch (e) {
                console.error(e);
            }
        }
        poll();
        setInterval(poll, 5000);
    </script>
</body>
</html>`;

    return {
        statusCode: 200,
        headers: { "Content-Type": "text/html" },
        body: html
    }
}