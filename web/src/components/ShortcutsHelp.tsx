import Modal from "./Modal";

const KEYS: [string, string][] = [
  ["/", "Focus the search bar"],
  ["Enter", "Run search / accept suggestion"],
  ["Tab", "Accept autocomplete suggestion"],
  ["↑ ↓", "Move through suggestions"],
  ["j / k", "Next / previous result"],
  ["o", "Open selected resource in Datadog"],
  ["f", "Favorite selected resource"],
  ["s", "Save current search"],
  ["e", "Export results as CSV"],
  ["[ / ]", "Previous / next page"],
  ["Esc", "Close suggestions, dialogs or inspector"],
  ["?", "Show this help"],
];

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="kv-table">
        <tbody>
          {KEYS.map(([k, d]) => (
            <tr key={k}>
              <td><kbd>{k}</kbd></td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
