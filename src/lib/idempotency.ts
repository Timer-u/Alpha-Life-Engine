/**
 * 表单内容驱动的稳定幂等键。
 *
 * 后端的 idempotency_key 守卫只对“同一 key 的重试”生效；若每次提交都
 * 重新 crypto.randomUUID()，请求超时（但后端已入账）后用户再点一次会带
 * 新 key 绕过守卫，重复入金/买入真实落库。key 在表单内容不变期间稳定
 * 复用，提交成功后调用 rotate() 轮换。
 */
export class IdempotencyKeyHolder {
  private key = crypto.randomUUID();
  private content = '';

  /** 当前内容对应的 key；内容变化时自动重新生成。 */
  keyFor(content: string): string {
    if (content !== this.content) {
      this.content = content;
      this.key = crypto.randomUUID();
    }
    return this.key;
  }

  /** 提交成功后轮换，下一次（内容可能相同）提交不再复用旧 key。 */
  rotate(): void {
    this.key = crypto.randomUUID();
  }
}
