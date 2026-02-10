import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb"
import UAParser from "ua-parser-js"

import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose"

const firehose = new FirehoseClient({})
const STREAM_NAME = process.env.FIREHOSE_STREAM_NAME

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const TABLE_NAME = process.env.DYNAMODB_TABLE

// 1x1 transparent GIF
const PIXEL = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
)

export const handler = async (event) => {
    const method = event?.requestContext?.http?.method
    const isPixel = method === "GET"

    let payload = null
    if (!isPixel && event.body) {
        const body = event.isBase64Encoded
            ? Buffer.from(event.body, "base64").toString("utf8")
            : event.body
        try {
            payload = JSON.parse(body)
        } catch {
            payload = body
        }
    }

    const record = {
        ts: new Date().toISOString(),
        requestId: event?.requestContext?.requestId,
        method,
        path: event?.requestContext?.http?.path,
        ip: event?.requestContext?.http?.sourceIp,
        ua: event?.headers?.["user-agent"],
        referer: event?.headers?.["referer"],
        query: event?.queryStringParameters,
        payload
    }

    try {
        const ua = new UAParser(record.ua)
        record.browser = ua.getBrowser()?.name || 'Unknown'
        record.device = ua.getDevice()?.type || 'Unknown'
        record.os = ua.getOS()?.name || 'Unknown'
    } catch (err) {
        console.warn("UAParser failed", { ua: record.ua, error: err?.message, requestId: record.requestId })
    }

    await Promise.all([
        putFirehose(record),
        updateStats(record)
    ])

    if (isPixel) {
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "image/gif",
                "Cache-Control": "no-store, no-cache, must-revalidate, private"
            },
            body: PIXEL.toString("base64"),
            isBase64Encoded: true
        }
    }

    return { statusCode: 202, body: "" }
}

const putFirehose = async (record) => {
    await firehose.send(
        new PutRecordCommand({
            DeliveryStreamName: STREAM_NAME,
            Record: {
                Data: Buffer.from(JSON.stringify(record) + "\n")
            }
        })
    )
}

const updateStats = async (record) => {
    const promises = [
        updateDailyCounter(),
        addEvent(record),
        updateCounter('os', record.os),
        updateCounter('browser', record.browser),
        updateCounter('device', record.device),
    ]

    if (record.referer) {
        promises.push(updatePageCounter(record))
    }
    await Promise.allSettled(promises)
}

const updateDailyCounter = async () => {
    const ttl = Math.floor(Date.now() / 1000) + 86400 * 7
    const today = new Date().toISOString().split('T').at(0)

    await dynamodb.send(
        new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: "COUNTER#daily",
                SK: today
            },
            UpdateExpression: "ADD #count :inc SET #ttl = :ttl",
            ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
            ExpressionAttributeValues: { ":inc": 1, ":ttl": ttl }
        })
    )
}

const updatePageCounter = async (record) => {
    const ttl = Math.floor(Date.now() / 1000) + 86400 * 7

    await dynamodb.send(
        new UpdateCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: "COUNTER#page",
                SK: record.referer
            },
            UpdateExpression: "ADD #count :inc SET #ttl = :ttl",
            ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
            ExpressionAttributeValues: { ":inc": 1, ":ttl": ttl },
        })
    )
}

const addEvent = async (record) => {
    const ttl = Math.floor(Date.now() / 1000) + 86400 * 7

    await dynamodb.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                PK: "EVENT#recent",
                SK: `${record.ts}/${record.requestId}`,
                ...record,
                ttl: ttl
            },
        })
    )
}

const updateCounter = async (type, value) => {
    if(!value) return

    const ttl = Math.floor(Date.now() / 1000) + 86400 * 7
    await dynamodb.send(
        new UpdateCommand({
            TableName: TABLE_NAME,
            KEY: {
                PK: `COUNTER#${type}`,
                SK: value
            },
            UpdateExpression: "ADD #count :inc SET #ttl = :ttl",
            ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl"},
            ExpressionAttributeValues: { ":inc": 1, ":ttl": ttl}
        })
    )
}