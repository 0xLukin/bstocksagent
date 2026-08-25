import { NextResponse } from "next/server";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://127.0.0.1:8787";

export async function POST(req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  const body = await req.json();
  const res = await fetch(`${RUNTIME}/intents/${intentId}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return NextResponse.json(json, { status: res.status });
}
