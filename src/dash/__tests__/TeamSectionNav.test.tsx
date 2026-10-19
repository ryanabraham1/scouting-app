import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import TeamSectionNav from '@/dash/TeamSectionNav';

const SECTIONS = [
  { id: 'sec-a', label: 'Overview' },
  { id: 'sec-b', label: 'EPA' },
  { id: 'sec-c', label: 'Notes', count: 4 },
];

describe('TeamSectionNav', () => {
  it('renders a link per section with counts', () => {
    const { getByTestId } = render(<TeamSectionNav sections={SECTIONS} />);
    expect(getByTestId('team-section-link-sec-b').textContent).toContain('EPA');
    expect(getByTestId('team-section-link-sec-c').textContent).toContain('4');
    expect(getByTestId('team-section-link-sec-a').getAttribute('aria-current')).toBe('true');
  });

  it('one click jumps to the section and marks it active', () => {
    const target = document.createElement('div');
    target.id = 'sec-b';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    const { getByTestId } = render(<TeamSectionNav sections={SECTIONS} />);
    const link = getByTestId('team-section-link-sec-b');

    fireEvent.click(link);
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(link.getAttribute('aria-current')).toBe('true');
    target.remove();
  });

  it('renders nothing for fewer than two sections', () => {
    const { queryByTestId } = render(<TeamSectionNav sections={[SECTIONS[0]]} />);
    expect(queryByTestId('team-section-nav')).toBeNull();
  });
});
