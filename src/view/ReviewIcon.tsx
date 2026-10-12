import React from 'react';

type IconName = 'more' | 'search' | 'open' | 'collapse' | 'chevron' | 'close';
const paths: Record<IconName, React.ReactNode> = {
  more: <><circle cx="4" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12" cy="8" r=".9" /></>,
  search: <><path d="M10.5 13.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h5l3 3v2" /><path d="M9 2.5v3h3" /><circle cx="10.5" cy="10" r="2.5" /><path d="m12.3 11.8 2.2 2.2" /></>,
  open: <><path d="M9 2.5h4.5V7M13 3 7.5 8.5" /><path d="M6.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5" /></>,
  collapse: <><path d="M5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V11" /><rect x="5" y="2" width="9" height="9" rx="1.5" /><path d="M7.5 6.5h4" /></>,
  chevron: <path d="m6 4 4 4-4 4" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
};
export default function ReviewIcon({ name }: { name: IconName }) {
  return <svg className="dv-icon" viewBox="0 0 16 16" width="16" height="16" fill={name === 'more' ? 'currentColor' : 'none'} stroke={name === 'more' ? 'none' : 'currentColor'} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
