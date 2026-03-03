import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis"
import { UAParser } from 'ua-parser-js'

const kinesis = new KinesisClient({})
const STREAM_NAME = process.env.KINESIS_STREAM_NAME

// 1x1 transparent GIF
const PIXEL = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
)

export const handler = async (event) => {
    const record = {
        ts: new Date().toISOString(),
        requestId: event?.requestContext?.requestId,
        method: "GET",
        path: event?.requestContext?.http?.path,
        ip: event?.requestContext?.http?.sourceIp,
        ua: event?.headers?.["user-agent"],
        referer: event?.headers?.["referer"],
        query: event?.queryStringParameters,
    }

    try {
        const ua = new UAParser(record.ua)
        record.browser = ua.getBrowser()?.name || 'Unknown'
        record.device = ua.getDevice()?.type || 'Desktop'
        record.os = ua.getOS()?.name || 'Unknown'
    } catch (err) {
        console.warn("UAParser failed", { ua: record.ua, error: err?.message, requestId: record.requestId })
    }

    await putKinesis(record)

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

const putKinesis = async (record) => {
    await kinesis.send(
        new PutRecordCommand({
            StreamName: STREAM_NAME,
            PartitionKey: record.requestId,
            Data: Buffer.from(JSON.stringify(record))
        })
    )
}
