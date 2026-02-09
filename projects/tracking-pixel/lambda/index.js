import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose"

const firehose = new FirehoseClient({})
const STREAM_NAME = process.env.FIREHOSE_STREAM_NAME

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

    await firehose.send(
        new PutRecordCommand({
            DeliveryStreamName: STREAM_NAME,
            Record: {
                Data: Buffer.from(JSON.stringify(record) + "\n")
            }
        })
    )

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