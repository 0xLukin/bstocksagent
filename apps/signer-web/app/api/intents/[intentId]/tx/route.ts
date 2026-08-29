import { NextResponse } from "next/server";
import { runtimeOrigin } from "@/lib/runtimeOrigin";

export async function POST(req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  const body = await req.json();
  const res = await fetch(`${runtimeOrigin()}/intents/${intentId}/tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return NextResponse.json(json, { status: res.status });
}
