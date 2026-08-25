export default function HomePage() {
  return (
    <main>
      <h1>bStocks 非托管签名页</h1>
      <p className="muted">
        请从 Agent 对话里打开形如 <code>/t/意图ID</code> 的链接。本页只连 BNB Chain，由你的钱包广播交易。
        Agent 私钥不会出现在此页面。
      </p>
      <div className="card">
        <h2>请注意</h2>
        <ul className="muted">
          <li>不构成投资建议。</li>
          <li>美国及受限地区用户请勿使用。</li>
          <li>bStocks 是证书类敞口，不是直接持股。</li>
          <li>合约使用 raw 数量；界面展示 UI 股数（ERC-8056）。</li>
        </ul>
      </div>
    </main>
  );
}
