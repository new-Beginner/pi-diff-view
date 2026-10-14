import React, { useEffect, useId, useRef, useState } from 'react';
import type { Scope } from '../core/contracts';
import ReviewIcon from './ReviewIcon';

interface ScopePickerProps {
  label: string;
  value: Scope;
  options: { value: Scope; label: string }[];
  disabled: boolean;
  onChange: (value: Scope) => void;
}

/** A themed scope menu; only explicit selection changes the review request. */
export default function ScopePicker({ label, value, options, disabled, onChange }: ScopePickerProps) {
  const [open, setOpen] = useState(false);
  const id = useId(), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  const focusOption = (index: number) => root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus();
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  useEffect(() => { if (open) focusOption(selected); }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const choose = (scope: Scope) => { if (!disabled) { close(true); if (scope !== value) onChange(scope); } };
  return <div className="dv-scope-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
  }}>
    <button ref={trigger} type="button" className="dv-scope" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} data-value={value} disabled={disabled} onClick={() => setOpen(current => !current)} onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); if (!open) setOpen(true); }
    }}><span>{options[selected]?.label}</span><span className="dv-scope-arrow"><ReviewIcon name="chevron" /></span></button>
    {open && <div id={id} className="dv-menu-body dv-scope-options" role="listbox" aria-label={label} onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length : -1;
      if (next >= 0) { event.preventDefault(); event.stopPropagation(); focusOption(next); }
      else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const match = options.findIndex((option, index) => index > current && option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
        const fallback = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
        if (match >= 0 || fallback >= 0) { event.preventDefault(); focusOption(match >= 0 ? match : fallback); }
      }
    }}>{options.map((option, index) => <React.Fragment key={option.value}>
      {index > 0 && (option.value === 'unstaged' || option.value === 'commit') && <hr role="presentation" />}
      <button type="button" role="option" aria-selected={option.value === value} data-value={option.value} tabIndex={-1} onClick={() => choose(option.value)}><span>{option.label}</span><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ visibility: option.value === value ? 'visible' : 'hidden' }}><path d="m3 8 3 3 7-7" /></svg></button>
    </React.Fragment>)}</div>}
  </div>;
}
