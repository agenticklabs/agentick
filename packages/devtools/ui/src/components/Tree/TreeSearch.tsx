interface TreeSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function TreeSearch({ value, onChange }: TreeSearchProps) {
  return (
    <div className="tree-search">
      <svg className="tree-search-icon" viewBox="0 0 16 16" fill="currentColor">
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
      </svg>
      <input
        type="text"
        className="tree-search-input"
        placeholder="Search components..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="tree-search-clear" onClick={() => onChange("")}>
          &times;
        </button>
      )}
    </div>
  );
}
