// tests/fixtures/report.ts
import type { ReportInput } from '@shared/report'

export const sampleReport: ReportInput = {
  overview: { headline: '登入流程多了一道鎖定關卡', summary: '在 IP 限流之後加入 lockoutGuard。' },
  architecture: {
    before: {
      nodes: [
        { id: 'client', label: 'Client', status: 'unchanged', files: [] },
        { id: 'login', label: 'login.ts', status: 'unchanged', files: ['src/auth/login.ts'] }
      ],
      edges: [{ from: 'client', to: 'login' }]
    },
    after: {
      nodes: [
        { id: 'client', label: 'Client', status: 'unchanged', files: [] },
        { id: 'guard', label: 'lockoutGuard', status: 'added', files: ['src/auth/lockout.ts'] },
        { id: 'login', label: 'login.ts', status: 'modified', files: ['src/auth/login.ts'] }
      ],
      edges: [
        { from: 'client', to: 'guard' },
        { from: 'guard', to: 'login' }
      ]
    }
  },
  decisions: [
    {
      id: 'd1',
      title: '計數存在 Redis',
      chosen: '既有 Redis',
      rejected: ['in-memory'],
      rationale: '多台機器共享',
      source: { type: 'branch', ref: 'b1' }
    }
  ],
  limitations: [{ title: 'Redis 掛掉時放行', detail: 'fail-open', severity: 'medium' }],
  followups: [{ title: '後台解鎖', detail: '' }],
  file_notes: [
    {
      path: 'src/auth/lockout.ts',
      why: '獨立計數邏輯',
      hunks: [{ line_start: 12, line_end: 20, why: 'TTL 用 EXPIRE' }]
    }
  ],
  verification: [{ command: 'npm test' }],
  custom_blocks: [{ id: 'state-machine', title: '鎖定狀態機', html: '<div>正常 → 鎖定</div>' }]
}
