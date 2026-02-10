import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb"

// Load templates once at cold start
const __dirname = dirname(fileURLToPath(import.meta.url))
const demoHtml = readFileSync(join(__dirname, 'templates/demo.html'), 'utf-8')
const dashboardHtml = readFileSync(join(__dirname, 'templates/dashboard.html'), 'utf-8')

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE_NAME = process.env.DYNAMODB_TABLE
const API_ENDPOINT = process.env.API_ENDPOINT

export const handler = async (event) => {
    const path = event?.requestContext?.http?.path

    switch (path) {
        case "/":
            return { statusCode: 302, headers: { Location: "/demo" } }
        case "/demo":
            return html(demoHtml.replaceAll('{{API_ENDPOINT}}', API_ENDPOINT))
        case "/dashboard":
            return html(dashboardHtml)
        case "/api/stats":
            return await serveStats()
        default:
            return { statusCode: 404, body: "Not found" }
    }
}

function html(body) {
    return {
        statusCode: 200,
        headers: { "Content-Type": "text/html" },
        body
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
                KeyConditionExpression: "PK = :pk",
                ExpressionAttributeValues: { ":pk": "COUNTER#page" },
            })
        ),
        dynamodb.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "PK = :pk",
                ExpressionAttributeValues: { ":pk": "EVENT#recent" },
                ScanIndexForward: false,
                Limit: 10,
            })
        ),
        dynamodb.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "PK = :pk",
                ExpressionAttributeValues: { ":pk": "COUNTER#browser" },
            })
        ),
        dynamodb.send(
            new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "PK = :pk",
                ExpressionAttributeValues: { ":pk": "COUNTER#device" },
            })
        ),
    ])

    const sortByCount = (items) =>
        (items ?? []).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            dailyCount: results[0].Item?.count ?? 0,
            topPages: sortByCount(results[1].Items).slice(0, 5),
            recentEvents: results[2].Items ?? [],
            browsers: sortByCount(results[3].Items).slice(0, 5),
            devices: sortByCount(results[4].Items),
        })
    }
}
