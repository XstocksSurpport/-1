import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, ethers } from "ethers";
import {
  DEFAULT_RECIPIENT,
  DEFAULT_TOKEN,
  DEFAULT_WBNB,
  PCS_V2_FACTORY,
  assertBsc,
  getLpBalance,
  removeLiquidityToRecipient,
  resolvePair,
  resolvePairByLpAddress,
  scanFarmPositions,
  transferLp,
  unstakeAll,
} from "./lib/recovery.js";
import { connectWallet, ensureBscChain, getEthereum } from "./lib/wallet.js";
import "./App.css";

function useLog() {
  const [lines, setLines] = useState([]);
  const log = useCallback((msg, type = "info") => {
    const t = new Date().toISOString().slice(11, 19);
    setLines((prev) => [...prev, { t, msg, type }]);
  }, []);
  const clear = useCallback(() => setLines([]), []);
  return { lines, log, clear };
}

export default function App() {
  const { lines, log, clear } = useLog();
  const [account, setAccount] = useState(null);
  const [chainOk, setChainOk] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 填了则按 LP 合约扫，不再用 Factory+双币 */
  const [lpPairAddress, setLpPairAddress] = useState("");
  const [token, setToken] = useState(DEFAULT_TOKEN);
  const [wbnb, setWbnb] = useState(DEFAULT_WBNB);
  const [recipient, setRecipient] = useState(DEFAULT_RECIPIENT);
  const [factory, setFactory] = useState(PCS_V2_FACTORY);
  const [skipFarmScan, setSkipFarmScan] = useState(false);

  const [scan, setScan] = useState(null);

  const provider = useMemo(() => {
    const eth = getEthereum();
    if (!eth) return null;
    return new BrowserProvider(eth);
  }, [account]);

  const refreshChain = useCallback(async () => {
    const eth = getEthereum();
    if (!eth) {
      setChainOk(false);
      return;
    }
    const cid = BigInt(await eth.request({ method: "eth_chainId" }));
    setChainOk(cid === 56n);
  }, []);

  useEffect(() => {
    const eth = getEthereum();
    if (!eth) return;
    const onChain = () => {
      refreshChain();
    };
    const onAccounts = (accs) => {
      if (!accs?.length) {
        setAccount(null);
        setScan(null);
      } else {
        setAccount(accs[0]);
      }
    };
    eth.on("chainChanged", onChain);
    eth.on("accountsChanged", onAccounts);
    refreshChain();
    return () => {
      eth.removeListener("chainChanged", onChain);
      eth.removeListener("accountsChanged", onAccounts);
    };
  }, [refreshChain]);

  const onConnect = async () => {
    clear();
    try {
      const addr = await connectWallet();
      setAccount(addr);
      await ensureBscChain();
      await refreshChain();
      log("已连接钱包。");
    } catch (e) {
      log(e.message || String(e), "err");
    }
  };

  const onScan = async () => {
    if (!provider || !account) return;
    clear();
    setBusy(true);
    setScan(null);
    try {
      const eth = getEthereum();
      if (eth) {
        const hex = await eth.request({ method: "eth_chainId" });
        assertBsc(BigInt(hex));
      } else {
        const net = await provider.getNetwork();
        assertBsc(net.chainId);
      }

      let pairAddr;
      let pair;
      let t0;
      let t1;
      let tokenResolved;
      let wbnbResolved;

      const lpIn = lpPairAddress.trim();
      if (lpIn) {
        log("按 LP Pair 合约地址解析 token0 / token1 …");
        const r = await resolvePairByLpAddress(provider, lpIn);
        pairAddr = r.pairAddr;
        pair = r.pair;
        t0 = r.t0;
        t1 = r.t1;
        tokenResolved = t0;
        wbnbResolved = t1;
        log(`LP 合约: ${pairAddr}`, "ok");
        log(`token0: ${t0}`);
        log(`token1: ${t1}`);
      } else {
        const tokenA = ethers.getAddress(token.trim());
        const tokenB = ethers.getAddress(wbnb.trim());
        const fac = ethers.getAddress(factory.trim());
        log("正在通过 Factory + 双币查询交易对…");
        const r = await resolvePair(provider, tokenA, tokenB, fac);
        pairAddr = r.pairAddr;
        pair = r.pair;
        t0 = r.t0;
        t1 = r.t1;
        tokenResolved = tokenA;
        wbnbResolved = tokenB;
        log(`交易对: ${pairAddr}`, "ok");
      }

      log("正在读取钱包 LP 余额…");
      const lpBal = await getLpBalance(pair, account);
      log(`钱包 LP 余额: ${lpBal.toString()}`);

      let positions = { v1: [], v2: [] };
      if (skipFarmScan) {
        log("已勾选「跳过农场扫描」，未查询 MasterChef。", "info");
      } else {
        log("正在扫描 MasterChef V1/V2（已用 Multicall 合并请求，避免卡死）…");
        positions = await scanFarmPositions(provider, pairAddr, account, {
          onProgress: (m) => log(m),
        });
      }

      const flat = [...positions.v2, ...positions.v1];
      setScan({
        pairAddr,
        t0,
        t1,
        tokenResolved,
        wbnbResolved,
        positions: flat,
        lpBal,
        scanByLpContract: Boolean(lpIn),
      });

      log(`农场质押记录: ${flat.length} 处`, flat.length ? "ok" : "info");
      positions.v2.forEach((p) =>
        log(`  MC V2 pid=${p.pid} amount=${p.amount.toString()}`),
      );
      positions.v1.forEach((p) =>
        log(`  MC V1 pid=${p.pid} amount=${p.amount.toString()}`),
      );

      if (flat.length === 0 && lpBal === 0n) {
        log(
          "未找到农场质押且钱包无该 LP。若你确定有流动性：① 流动性是否在别的 DEX / 别的 Factory；② 是否 Pancake V3（NFT）；③ 是否在第三方质押合约。可尝试修改 Factory 后重扫，或到 BscScan 查钱包「代币持有」与「交互合约」。",
          "info",
        );
      }
    } catch (e) {
      log(e.shortMessage || e.message || String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const runUnstake = async () => {
    if (!provider || !account || !scan?.positions?.length) return;
    setBusy(true);
    try {
      const signer = await provider.getSigner();
      await unstakeAll(signer, scan.positions, (m) => log(m));
      log("解押完成。请再次「扫描」确认 LP 已到钱包。", "ok");
    } catch (e) {
      log(e.shortMessage || e.message || String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const runRemove = async () => {
    if (!provider || !account || !scan) return;
    setBusy(true);
    try {
      const net = await provider.getNetwork();
      assertBsc(net.chainId);
      const signer = await provider.getSigner();
      const rec = ethers.getAddress(recipient.trim());
      const lpAmount = await getLpBalance(
        new ethers.Contract(scan.pairAddr, ["function balanceOf(address) view returns (uint256)"], provider),
        account,
      );
      if (lpAmount === 0n) {
        log("当前无 LP 可撤。", "err");
        return;
      }
      await removeLiquidityToRecipient(
        signer,
        provider,
        {
          pairAddr: scan.pairAddr,
          t0: scan.t0,
          t1: scan.t1,
          token: scan.tokenResolved,
          wbnb: scan.wbnbResolved,
          recipient: rec,
          lpAmount,
          userAddress: account,
        },
        (m) => log(m),
      );
      log("已完成撤池与转出。", "ok");
    } catch (e) {
      log(e.shortMessage || e.message || String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const runTransferLp = async () => {
    if (!provider || !account || !scan) return;
    setBusy(true);
    try {
      const net = await provider.getNetwork();
      assertBsc(net.chainId);
      const signer = await provider.getSigner();
      const rec = ethers.getAddress(recipient.trim());
      const pairC = new ethers.Contract(
        scan.pairAddr,
        ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"],
        provider,
      );
      const lpAmount = await pairC.balanceOf(account);
      if (lpAmount === 0n) {
        log("无 LP 可转。", "err");
        return;
      }
      await transferLp(signer, scan.pairAddr, rec, lpAmount, (m) => log(m));
      log("LP 已转到接收地址。", "ok");
    } catch (e) {
      log(e.shortMessage || e.message || String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <h1>PancakeSwap V2 LP 找回</h1>
      <p className="sub">
        在浏览器内用钱包签名。支持<strong>直接填 LP 合约地址</strong>扫描，或通过 Factory+双币查询。农场为
        Pancake MasterChef V1/V2。
      </p>

      <div className="panel">
        <div className="row">
          <button type="button" className="primary" onClick={onConnect} disabled={busy}>
            连接钱包
          </button>
          {account && (
            <span className="status-pill ok">
              {account.slice(0, 6)}…{account.slice(-4)}
            </span>
          )}
          {account && (
            <span className={chainOk ? "status-pill ok" : "status-pill warn"}>
              {chainOk ? "BNB Chain" : "请切换到 BNB Chain"}
            </span>
          )}
        </div>
        {!getEthereum() && (
          <p className="sub" style={{ marginBottom: 0 }}>
            未检测到 <code>window.ethereum</code>，请用支持钱包的浏览器打开本页。
          </p>
        )}
      </div>

      <div className="panel">
        <div className="row">
          <label className="field">
            <span>LP Pair 合约地址（推荐，填了则忽略下面 Factory / 双币）</span>
            <input
              value={lpPairAddress}
              onChange={(e) => setLpPairAddress(e.target.value)}
              placeholder="0x… 在 BscScan 打开池子合约复制"
            />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>TOKEN（仅在未填 LP 合约时使用）</span>
            <input value={token} onChange={(e) => setToken(e.target.value)} disabled={Boolean(lpPairAddress.trim())} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>WBNB（仅在未填 LP 合约时使用）</span>
            <input value={wbnb} onChange={(e) => setWbnb(e.target.value)} disabled={Boolean(lpPairAddress.trim())} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>接收地址</span>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>Factory（仅未填 LP 合约时使用）</span>
            <input
              value={factory}
              onChange={(e) => setFactory(e.target.value)}
              disabled={Boolean(lpPairAddress.trim())}
            />
          </label>
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={skipFarmScan}
              onChange={(e) => setSkipFarmScan(e.target.checked)}
            />
            跳过农场扫描（只查交易对 + 钱包 LP，排查卡顿时用）
          </label>
        </div>
        <div className="actions">
          <button type="button" className="primary" onClick={onScan} disabled={busy || !account || !chainOk}>
            扫描链上状态
          </button>
        </div>
      </div>

      {scan && (
        <div className="panel">
          <strong>扫描结果</strong>
          {scan.scanByLpContract && (
            <p className="sub" style={{ marginTop: "0.25rem" }}>
              方式：按 LP 合约地址
            </p>
          )}
          <p className="sub" style={{ marginTop: "0.35rem" }}>
            token0 / token1:{" "}
            <a href={`https://bscscan.com/address/${scan.t0}`} target="_blank" rel="noreferrer">
              {scan.t0.slice(0, 10)}…
            </a>
            {" / "}
            <a href={`https://bscscan.com/address/${scan.t1}`} target="_blank" rel="noreferrer">
              {scan.t1.slice(0, 10)}…
            </a>
          </p>
          <p className="sub" style={{ marginTop: "0.35rem" }}>
            Pair:{" "}
            <a href={`https://bscscan.com/address/${scan.pairAddr}`} target="_blank" rel="noreferrer">
              {scan.pairAddr}
            </a>
          </p>
          <div className="actions">
            <button type="button" onClick={runUnstake} disabled={busy || !scan.positions.length}>
              从农场解押全部
            </button>
            <button type="button" className="primary" onClick={runRemove} disabled={busy}>
              撤池并把 TOKEN+WBNB 转给接收地址
            </button>
            <button type="button" className="danger" onClick={runTransferLp} disabled={busy}>
              仅转 LP 凭证（不撤池）
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>日志</strong>
          <button type="button" onClick={clear} disabled={busy}>
            清空
          </button>
        </div>
        <div className="log">
          {lines.map((l, i) => (
            <div key={i} className={l.type === "err" ? "err" : l.type === "ok" ? "ok" : ""}>
              [{l.t}] {l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
