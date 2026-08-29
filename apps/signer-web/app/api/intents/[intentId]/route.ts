import { NextResponse } from "next/server";
import { runtimeOrigin } from "@/lib/runtimeOrigin";

export async function GET(_req: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  const res = await fetch(`${runtimeOrigin()}/intents/${intentId}`, { cache: "no-store" });
  const json = await res.json();
  return NextResponse.json(json, { status: res.status });
}
