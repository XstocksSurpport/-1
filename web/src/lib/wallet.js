const BSC = {
  chainId: "0x38",
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: ["https://bsc-dataseed.binance.org/"],
  blockExplorerUrls: ["https://bscscan.com"],
};

export function getEthereum() {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

export async function connectWallet() {
  const eth = getEthereum();
  if (!eth) {
    throw new Error("未检测到钱包扩展，请安装 MetaMask 或其它 EIP-1193 钱包。");
  }
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("用户未授权账户");
  return accounts[0];
}

export async function ensureBscChain() {
  const eth = getEthereum();
  if (!eth) throw new Error("无钱包");
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BSC.chainId }],
    });
  } catch (e) {
    if (e.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [BSC],
      });
      return;
    }
    throw e;
  }
}
