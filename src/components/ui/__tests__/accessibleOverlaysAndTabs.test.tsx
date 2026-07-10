import { useState } from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/Sheet';
import { IconTabs } from '@/components/ui/IconTabs';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';

function SheetHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open details
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Report details">
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Sheet>
    </>
  );
}

describe('accessible shared controls', () => {
  it('names and traps a sheet, closes on Escape, and restores trigger focus', async () => {
    const view = render(<SheetHarness />);
    const trigger = view.getByRole('button', { name: 'Open details' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = view.getByRole('dialog', { name: 'Report details' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(document.activeElement).toBe(close));

    const last = within(dialog).getByRole('button', { name: 'Last action' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('uses roving focus and arrow selection in IconTabs', () => {
    const onChange = vi.fn();
    const view = render(
      <IconTabs
        ariaLabel="Sections"
        value="one"
        onChange={onChange}
        tabs={[
          { value: 'one', label: 'One', icon: <span /> },
          { value: 'two', label: 'Two', icon: <span /> },
        ]}
      />,
    );
    const tabs = view.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('two');
    expect(document.activeElement).toBe(tabs[1]);
  });

  it('uses roving focus and Home/End selection in SegmentedToggle', () => {
    const onChange = vi.fn();
    const view = render(
      <SegmentedToggle
        ariaLabel="Mode"
        value="middle"
        onChange={onChange}
        options={[
          { value: 'first', label: 'First' },
          { value: 'middle', label: 'Middle' },
          { value: 'last', label: 'Last' },
        ]}
      />,
    );
    const tabs = view.getAllByRole('tab');
    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('last');
    expect(document.activeElement).toBe(tabs[2]);
  });
});
