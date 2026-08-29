import { NextResponse } from "next/server";
import { runtimeOrigin } from "@/lib/runtimeOrigin";

export async function POST(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  const res = await fetch(`${runtimeOrigin()}/intents/${intentId}/cancel`, { method: "POST" });
  const json = await res.json();
  return NextResponse.json(json, { status: res.status });
}
