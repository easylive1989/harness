import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// vitest 沒開 globals，Testing Library 不會自動在每個測試後卸載畫面
afterEach(cleanup)
