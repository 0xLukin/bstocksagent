import { SignerClient } from "./SignerClient";

export default async function IntentPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  return (
    <main className="stage">
      <SignerClient intentId={intentId} />
    </main>
  );
}

