/** Pure probation policy; transport and timers belong to the launcher. */
class HealthWindow {
  constructor(duration = 45000, interval = 5000) {
    this.duration = duration;
    this.interval = interval;
    this.reset();
  }
  reset() { this.since = undefined; this.last = undefined; this.samples = 0; this.failures = 0; }
  record(ok, now = Date.now()) {
    if (!ok) { this.since = undefined; this.samples = 0; this.failures++; return; }
    if (this.last !== undefined && now - this.last > this.interval * 2) {
      this.since = undefined; this.samples = 0;
    }
    this.since ??= now;
    this.last = now;
    this.samples++;
    this.failures = 0;
  }
  healthy(now = Date.now()) {
    return this.failures === 0 && this.samples >= 3 && this.since !== undefined
      && now - this.since >= this.duration && now - this.last <= this.interval * 2;
  }
  failed() { return this.failures >= 3; }
}
module.exports = { HealthWindow };
