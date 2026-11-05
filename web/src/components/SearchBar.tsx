import { Search, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../api";
import { cx } from "../util";

interface Suggestion {
  value: string;
  label: string;
  hint: string;
  kind: string;
}

export interface SearchBarHandle {
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  large?: boolean;
  autoFocus?: boolean;
}

const SearchBar = forwardRef<SearchBarHandle, Props>(function SearchBar({ value, onChange, onSubmit, large, autoFocus }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !t.closest("input, textarea, select")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = ++seq.current;
    const t = setTimeout(() => {
      api<{ suggestions: Suggestion[] }>("/suggest", { params: { prefix: value } })
        .then((r) => {
          if (id === seq.current) {
            setItems(r.suggestions);
            setActive(-1);
          }
        })
        .catch(() => setItems([]));
    }, 140);
    return () => clearTimeout(t);
  }, [value, open]);

  const accept = (s: Suggestion) => {
    const parts = value.split(/(\s+)/);
    parts[parts.length - 1] = s.value;
    const next = parts.join("") + (s.kind === "field" ? "" : " ");
    onChange(next);
    setItems([]);
    input.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const visible = open && items.length > 0;
    if (e.key === "ArrowDown" && visible) {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp" && visible) {
      e.preventDefault();
      setActive((a) => Math.max(-1, a - 1));
    } else if (e.key === "Tab" && visible) {
      e.preventDefault();
      accept(items[Math.max(0, active)]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (visible && active >= 0) accept(items[active]);
      else {
        setOpen(false);
        onSubmit(value);
      }
    } else if (e.key === "Escape") {
      if (visible) setOpen(false);
      else input.current?.blur();
    }
  };

  return (
    <div className={cx("searchbar", large && "large")}>
      <form
        className="searchbar-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setOpen(false);
          onSubmit(value);
        }}
      >
        <div className="searchbar-input">
          <Search size={large ? 24 : 22} className="muted" aria-hidden />
          <input
            ref={input}
            value={value}
            autoFocus={autoFocus}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search name, IP, tag… e.g. ip:10.10.50.* OR name:eoc* OR tag:app:xyz"
            aria-label="Search query"
            aria-autocomplete="list"
            aria-expanded={open && items.length > 0}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKey}
          />
          {value && (
            <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { onChange(""); input.current?.focus(); }}>
              <X size={20} />
            </button>
          )}
        </div>
        <button type="submit" className="btn-primary search-btn">Search</button>
      </form>
      {open && items.length > 0 && (
        <ul className="suggest" role="listbox">
          {items.map((s, i) => (
            <li
              key={s.value + i}
              role="option"
              aria-selected={i === active}
              className={cx(i === active && "active")}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
            >
              <span className={`sg-kind sg-${s.kind}`}>{s.kind}</span>
              <span className="sg-label">{s.kind === "field" ? s.value : s.label}</span>
              <span className="muted small">{s.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

export default SearchBar;
