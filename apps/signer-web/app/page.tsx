export default function HomePage() {
  return (
    <main>
      <div className="sheet">
        <h1>Confirm with your wallet</h1>
        <p className="muted">
          Open the signer link from the agent chat. This page only shows what you pay and receive. Your wallet
          broadcasts. The agent never has your private key.
        </p>
        <ul className="risks">
          <li>Not investment advice. Do not use this from the United States or restricted regions.</li>
          <li>bStocks are certificates, not the underlying stock.</li>
        </ul>
      </div>
    </main>
  );
}
