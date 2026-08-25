import { SignerClient } from "./SignerClient";

export default async function IntentPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  return (
    <main>
      <h1>确认并签名</h1>
      <p className="muted">
        请用意图绑定的钱包连接。核对模拟结果、滑点、raw / UI 数量后再广播。本页不含 Agent 私钥。
      </p>
      <SignerClient intentId={intentId} />
    </main>
  );
}
