import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileClock,
  Gauge,
  HardDriveDownload,
  History,
  LayoutDashboard,
  LoaderCircle,
  Logs,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  Workflow
} from "lucide-react";
import type {
  CommandResult,
  HarnessSnapshot,
  HarnessStatus,
  RuntimeChannel
} from "../shared/contracts";

type View = "overview" | "runtime" | "recovery" | "logs";

const EMPTY_SNAPSHOT: HarnessSnapshot = {
  status: "starting",
  message: "正在连接桌面监督器",
  activeVersion: "—",
  activeSource: "bundled",
  lastKnownGoodVersion: "—",
  desktopVersion: "—",
  profile: "web",
  uptimeSeconds: 0,
  crashCount: 0,
  rollbackCount: 0,
  channel: "stable",
  autoStart: false,
  tokenSavingEnabled: true,
  logs: []
};

const STATUS_COPY: Record<HarnessStatus, { label: string; tone: string }> = {
  online: { label: "运行正常", tone: "good" },
  starting: { label: "正在启动", tone: "pending" },
  updating: { label: "正在升级", tone: "pending" },
  recovering: { label: "正在恢复", tone: "warn" },
  stopping: { label: "正在停止", tone: "pending" },
  stopped: { label: "已停止", tone: "quiet" },
  faulted: { label: "需要处理", tone: "bad" }
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} 小时 ${remainder} 分`;
}

function formatDate(value?: string): string {
  if (!value) return "尚未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? "is-on" : ""}`}
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span />
    </button>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [view, setView] = useState<View>("overview");
  const [busy, setBusy] = useState<string>();
  const [toast, setToast] = useState<{ ok: boolean; message: string }>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void window.harnessDesktop.getSnapshot().then(setSnapshot);
    window.harnessDesktop.subscribeSnapshot(setSnapshot);
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const uptime = useMemo(() => {
    if (!snapshot.startedAt || snapshot.status !== "online") return snapshot.uptimeSeconds;
    return Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.startedAt)) / 1000));
  }, [snapshot.startedAt, snapshot.status, snapshot.uptimeSeconds, tick]);

  const run = async (name: string, action: () => Promise<CommandResult>) => {
    setBusy(name);
    try {
      const response = await action();
      setToast(response);
      setSnapshot(await window.harnessDesktop.getSnapshot());
    } catch (error) {
      setToast({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const checkUpdates = async () => {
    setBusy("check-update");
    try {
      const update = await window.harnessDesktop.checkUpdates();
      setToast({
        ok: true,
        message: update.available ? `发现 ${update.latest}` : "当前已经是该通道的最新版本"
      });
      setSnapshot(await window.harnessDesktop.getSnapshot());
    } catch (error) {
      setToast({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const switchChannel = async (channel: RuntimeChannel) => {
    await run("channel", () => window.harnessDesktop.setChannel(channel));
  };

  const status = STATUS_COPY[snapshot.status];
  const isTransitioning = ["starting", "stopping", "updating", "recovering"].includes(snapshot.status);

  const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
    { id: "overview", label: "总览", icon: LayoutDashboard },
    { id: "runtime", label: "运行时与升级", icon: Workflow },
    { id: "recovery", label: "恢复中心", icon: ShieldCheck },
    { id: "logs", label: "诊断日志", icon: Logs }
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><span /></div>
          <div>
            <strong>DeepSeek</strong>
            <small>桌面版</small>
          </div>
        </div>

        <nav aria-label="主导航">
          <p className="nav-caption">工作区</p>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? "active" : ""}
                onClick={() => setView(item.id)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
                {view === item.id && <ChevronRight size={15} className="nav-arrow" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="mini-health">
            <span className={`status-dot ${status.tone}`} />
            <div>
              <strong>{status.label}</strong>
              <small>DSH {snapshot.activeVersion}</small>
            </div>
          </div>
          <div className="desktop-version">桌面版 {snapshot.desktopVersion}</div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">本地智能体控制台</p>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="top-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => void run("restart", () => window.harnessDesktop.restart())}
              disabled={Boolean(busy) || isTransitioning}
            >
              <RefreshCw size={16} className={busy === "restart" ? "spin" : ""} />
              重启
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void run("open", () => window.harnessDesktop.openWorkbench())}
              disabled={snapshot.status !== "online" || Boolean(busy)}
            >
              打开工作台 <ArrowUpRight size={17} />
            </button>
          </div>
        </header>

        <div className="content">
          {view === "overview" && (
            <>
              <section className="hero-card">
                <div className="hero-copy">
                  <div className={`status-pill ${status.tone}`}>
                    <span className="status-dot" />
                    {status.label}
                  </div>
                  <h2>你的 Harness，始终在稳定版本上醒来。</h2>
                  <p>{snapshot.message}</p>
                  <div className="hero-actions">
                    {snapshot.status === "stopped" || snapshot.status === "faulted" ? (
                      <button
                        type="button"
                        className="button primary large"
                        onClick={() => void run("start", () => window.harnessDesktop.start())}
                        disabled={Boolean(busy)}
                      >
                        <Play size={17} fill="currentColor" /> 启动运行时
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button secondary large"
                        onClick={() => void run("stop", () => window.harnessDesktop.stop())}
                        disabled={Boolean(busy) || isTransitioning}
                      >
                        <Square size={15} fill="currentColor" /> 停止
                      </button>
                    )}
                    <button type="button" className="text-button" onClick={() => setView("recovery")}>
                      查看恢复策略 <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
                <div className="orbital" aria-hidden="true">
                  <div className="orbit orbit-one"><i /></div>
                  <div className="orbit orbit-two"><i /></div>
                  <div className="core"><Activity size={34} /></div>
                </div>
              </section>

              <section className="metric-grid">
                <article className="metric-card">
                  <div className="metric-icon teal"><Gauge size={19} /></div>
                  <span>活动运行时</span>
                  <strong>DSH {snapshot.activeVersion}</strong>
                  <small>{snapshot.activeSource === "bundled" ? "随桌面捆绑" : "独立托管槽"}</small>
                </article>
                <article className="metric-card">
                  <div className="metric-icon blue"><Clock3 size={19} /></div>
                  <span>连续运行</span>
                  <strong>{formatDuration(uptime)}</strong>
                  <small>{snapshot.startedAt ? `始于 ${formatDate(snapshot.startedAt)}` : "等待运行时上线"}</small>
                </article>
                <article className="metric-card">
                  <div className="metric-icon green"><ShieldCheck size={19} /></div>
                  <span>最后稳定版</span>
                  <strong>{snapshot.lastKnownGoodVersion}</strong>
                  <small>{snapshot.rollbackCount} 次自动回滚</small>
                </article>
                <article className="metric-card">
                  <div className="metric-icon amber"><History size={19} /></div>
                  <span>崩溃窗口</span>
                  <strong>{snapshot.crashCount} / 3</strong>
                  <small>5 分钟动态窗口</small>
                </article>
              </section>

              <section className="two-column">
                <article className="panel update-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="section-kicker">版本通道</p>
                      <h3>运行时更新</h3>
                    </div>
                    <span className="channel-badge">{snapshot.channel === "stable" ? "稳定" : "预览"}</span>
                  </div>
                  <div className="version-route">
                    <div><small>当前</small><strong>{snapshot.activeVersion}</strong></div>
                    <div className="route-line"><span /></div>
                    <div><small>可用</small><strong>{snapshot.latestUpdate?.latest ?? "点击检查"}</strong></div>
                  </div>
                  <p className="muted">
                    新版本先进入隔离候选槽。只有通过配置烟测、启动探测和 45 秒观察期，才会成为稳定版本。
                  </p>
                  <div className="panel-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void checkUpdates()}
                      disabled={Boolean(busy)}
                    >
                      <RefreshCw size={16} className={busy === "check-update" ? "spin" : ""} /> 检查更新
                    </button>
                    {snapshot.latestUpdate?.available && (
                      <button
                        type="button"
                        className="button primary"
                        onClick={() =>
                          void run("install", () =>
                            window.harnessDesktop.installUpdate(snapshot.latestUpdate!.latest)
                          )
                        }
                        disabled={Boolean(busy)}
                      >
                        <HardDriveDownload size={16} /> 安装候选版
                      </button>
                    )}
                  </div>
                </article>

                <article className="panel protection-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="section-kicker">恢复链路</p>
                      <h3>三层恢复保护</h3>
                    </div>
                    <ShieldCheck size={21} className="accent-icon" />
                  </div>
                  <ol className="protection-list">
                    <li><span><Check size={13} /></span><div><strong>进程级自愈</strong><small>健康检查失败后指数退避重启</small></div></li>
                    <li><span><Check size={13} /></span><div><strong>版本级回滚</strong><small>候选异常立即切回 {snapshot.lastKnownGoodVersion}</small></div></li>
                    <li><span><Check size={13} /></span><div><strong>桌面级看门狗</strong><small>主进程异常退出后重新拉起</small></div></li>
                  </ol>
                </article>
              </section>
            </>
          )}

          {view === "runtime" && (
            <section className="settings-layout">
              <article className="panel wide-panel">
                <div className="panel-heading">
                  <div>
                    <p className="section-kicker">运行时</p>
                    <h3>版本与通道</h3>
                  </div>
                  <TerminalSquare size={21} className="accent-icon" />
                </div>
                <div className="setting-row">
                  <div><strong>活动版本</strong><small>当前由监督器启动的 DSH 运行时</small></div>
                  <code>{snapshot.activeSource}:{snapshot.activeVersion}</code>
                </div>
                <div className="setting-row">
                  <div><strong>稳定通道</strong><small>跟随 npm latest，仅接收经过发布的 RC/稳定版</small></div>
                  <button
                    type="button"
                    className={`choice ${snapshot.channel === "stable" ? "selected" : ""}`}
                    onClick={() => void switchChannel("stable")}
                  >稳定</button>
                </div>
                <div className="setting-row">
                  <div><strong>预览通道</strong><small>跟随 alpha，仅用于提前验证插件兼容性</small></div>
                  <button
                    type="button"
                    className={`choice ${snapshot.channel === "preview" ? "selected" : ""}`}
                    onClick={() => void switchChannel("preview")}
                  >预览</button>
                </div>
                <div className="setting-row">
                  <div><strong>开机启动</strong><small>Windows 登录后启动桌面监督器与 Harness</small></div>
                  <Toggle
                    checked={snapshot.autoStart}
                    label="切换开机启动"
                    onChange={() =>
                      void run("autostart", () =>
                        window.harnessDesktop.setAutoStart(!snapshot.autoStart)
                      )
                    }
                  />
                </div>
                <div className="setting-row">
                  <div><strong>省 token 模式</strong><small>使用官方工具输出裁剪与会话压缩；异常时自动关闭优化层并重试</small></div>
                  <Toggle
                    checked={snapshot.tokenSavingEnabled}
                    label="切换省 token 模式"
                    onChange={() =>
                      void run("token-saving", () =>
                        window.harnessDesktop.setTokenSaving(!snapshot.tokenSavingEnabled)
                      )
                    }
                  />
                </div>
                <div className="update-callout">
                  <HardDriveDownload size={22} />
                  <div>
                    <strong>非破坏性升级</strong>
                    <p>升级不会覆盖全局 dsh；桌面版使用独立托管目录，旧插件无法污染稳定恢复基线。</p>
                  </div>
                  <button type="button" className="button secondary" onClick={() => void checkUpdates()}>
                    检查更新
                  </button>
                </div>
              </article>
            </section>
          )}

          {view === "recovery" && (
            <section className="settings-layout">
              <article className="panel wide-panel">
                <div className="panel-heading">
                  <div><p className="section-kicker">恢复中心</p><h3>恢复状态</h3></div>
                  <RotateCcw size={21} className="accent-icon" />
                </div>
                <div className="recovery-route">
                  <div className="recovery-node current"><Activity size={19} /><small>当前版本</small><strong>{snapshot.activeVersion}</strong></div>
                  <div className="recovery-connector"><ChevronRight size={18} /></div>
                  <div className="recovery-node"><ShieldCheck size={19} /><small>最后稳定版</small><strong>{snapshot.lastKnownGoodVersion}</strong></div>
                  <div className="recovery-connector"><ChevronRight size={18} /></div>
                  <div className="recovery-node"><FileClock size={19} /><small>最终恢复</small><strong>捆绑版</strong></div>
                </div>
                <div className="recovery-facts">
                  <div><span>候选版本</span><strong>{snapshot.candidateVersion ?? "无"}</strong></div>
                  <div><span>窗口内故障</span><strong>{snapshot.crashCount}</strong></div>
                  <div><span>累计回滚</span><strong>{snapshot.rollbackCount}</strong></div>
                  <div><span>探测周期</span><strong>5 秒</strong></div>
                </div>
                <div className="info-banner">
                  <CircleAlert size={19} />
                  <p>捆绑版本连续失败 3 次后会安全停止，避免无限重启。日志会保留，用户数据不会被回退或覆盖。</p>
                </div>
              </article>
            </section>
          )}

          {view === "logs" && (
            <section className="logs-layout">
              <article className="panel log-panel">
                <div className="panel-heading">
                  <div><p className="section-kicker">实时诊断</p><h3>监督器事件</h3></div>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void run("logs", () => window.harnessDesktop.openLogs())}
                  >
                    <Logs size={16} /> 打开目录
                  </button>
                </div>
                <div className="terminal" aria-label="运行日志">
                  {snapshot.logs.length === 0 ? (
                    <p className="terminal-empty">等待第一条运行事件…</p>
                  ) : (
                    snapshot.logs.slice().reverse().map((line, index) => (
                      <div className="log-line" key={`${line}-${index}`}>
                        <span>{String(snapshot.logs.length - index).padStart(3, "0")}</span>
                        <code>{line}</code>
                      </div>
                    ))
                  )}
                </div>
              </article>
            </section>
          )}
        </div>
      </main>

      {toast && (
        <div className={`toast ${toast.ok ? "success" : "error"}`} role="status">
          {toast.ok ? <Check size={17} /> : <CircleAlert size={17} />}
          {toast.message}
        </div>
      )}

      {busy === "install" && (
        <div className="busy-overlay">
          <div className="busy-card">
            <LoaderCircle className="spin" size={28} />
            <strong>正在准备候选运行时</strong>
            <p>下载、安装并验证托管 profile。当前稳定版会继续保留。</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
