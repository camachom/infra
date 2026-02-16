import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb"
import { gzipSync } from "zlib"

const s3 = new S3Client({})
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const S3_BUCKET = process.env.S3_BUCKET
const TABLE_NAME = process.env.DYNAMODB_TABLE

export const handler = async (event) => {
    // Parse all records from Kinesis batch
    const records = event.Records.map(r =>
        JSON.parse(Buffer.from(r.kinesis.data, 'base64').toString())
    )

    await Promise.all([
        writeToS3(records),
        updateDynamoDB(records)
    ])
}

const writeToS3 = async (records) => {
    const now = new Date()
    const key = `events/year=${now.getUTCFullYear()}/month=${String(now.getUTCMonth()+1).padStart(2,'0')}/day=${String(now.getUTCDate()).padStart(2,'0')}/hour=${String(now.getUTCHours()).padStart(2,'0')}/${Date.now()}.json.gz`

    const body = records.map(r => JSON.stringify(r)).join('\n')

    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: gzipSync(body),
        ContentEncoding: 'gzip',
        ContentType: 'application/json'
    }))
}

const updateDynamoDB = async (records) => {
    const ttl = Math.floor(Date.now() / 1000) + 86400 * 7
    const today = new Date().toISOString().split('T').at(0)

    // Aggregate counters from batch
    const counters = { os: {}, browser: {}, device: {}, page: {} }

    for (const record of records) {
        if (record.os) counters.os[record.os] = (counters.os[record.os] || 0) + 1
        if (record.browser) counters.browser[record.browser] = (counters.browser[record.browser] || 0) + 1
        if (record.device) counters.device[record.device] = (counters.device[record.device] || 0) + 1
        if (record.referer) counters.page[record.referer] = (counters.page[record.referer] || 0) + 1
    }

    const updates = [
        // Daily counter (batch count)
        dynamodb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: "COUNTER#daily", SK: today },
            UpdateExpression: "ADD #count :inc SET #ttl = :ttl",
            ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
            ExpressionAttributeValues: { ":inc": records.length, ":ttl": ttl }
        }))
    ]

    // Aggregated counter updates
    for (const [type, values] of Object.entries(counters)) {
        for (const [value, count] of Object.entries(values)) {
            updates.push(
                dynamodb.send(new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { PK: `COUNTER#${type}`, SK: value },
                    UpdateExpression: "ADD #count :inc SET #ttl = :ttl",
                    ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
                    ExpressionAttributeValues: { ":inc": count, ":ttl": ttl }
                }))
            )
        }
    }

    // Store recent events (last few from batch for dashboard)
    const recentEvents = records.slice(-5)
    for (const record of recentEvents) {
        updates.push(
            dynamodb.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: {
                    PK: "EVENT#recent",
                    SK: `${record.ts}/${record.requestId}`,
                    ...record,
                    ttl
                }
            }))
        )
    }

    await Promise.allSettled(updates)
}
