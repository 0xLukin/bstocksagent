export default function HomePage() {
  return (
    <main className="stage">
      <div className="brand">
        <span className="brand-mark">bStocks</span>
        <p className="brand-note">非托管签名页</p>
      </div>
      <section className="ticket home-copy">
        <p className="eyebrow">从聊天打开链接</p>
        <h1>用你的钱包确认</h1>
        <p className="muted">
          Agent 聊天会给出签名链接。打开后只核对这一笔：支付多少、得到什么。广播由你的钱包完成，私钥不会离开钱包。
        </p>
        <ul className="risks">
          <li>不是投资建议。美国及受限地区不可使用。</li>
          <li>bStocks 是证书敞口，不是底层股票。</li>
        </ul>
      </section>
    </main>
  );
}
