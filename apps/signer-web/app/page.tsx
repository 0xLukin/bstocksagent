export default function HomePage() {
  return (
    <main>
      <div className="sheet">
        <h1>用你的钱包确认</h1>
        <p className="muted">
          从 Agent 对话打开签名链接。这里只展示你要付出和得到什么，由你的钱包广播。Agent 拿不到私钥。
        </p>
        <ul className="risks">
          <li>不是投资建议。美国及受限地区请勿使用。</li>
          <li>bStocks 是证书，不是股票本身。</li>
        </ul>
      </div>
    </main>
  );
}
