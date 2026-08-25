import { NextResponse } from "next/server";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://127.0.0.1:8787";

export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  const res = await fetch(`${RUNTIME}/intents/${intentId}/cancel`, { method: "POST" });
  const json = await res.json();
  return NextResponse.json(json, { status: res.status });
}
