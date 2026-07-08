import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import TenantTemplates from './index'
import * as api from '@/services/api'

vi.mock('@/services/api')

describe('TenantTemplates', () => {
  it('renders template list', async () => {
    vi.mocked(api.getTenantTemplates).mockResolvedValue({
      templates: [{
        template_id: 'tpl_1',
        name: 'Pro',
        tenant: { plan: 'pro', status: 'active' },
        created_at: Date.now(),
        updated_at: Date.now(),
      }],
    })
    render(<TenantTemplates />)
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument())
  })
})
