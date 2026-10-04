/** Share concurrent identical reads only. Never retain a completed value or rejection. */
export function coalescedRead<T>(maximum = 10000) {
  const flights = new Map<string, Promise<T>>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const current = flights.get(key);
    if (current) return current;
    if (flights.size >= maximum) return read();
    const pending = Promise.resolve()
      .then(read)
      .finally(() => {
        flights.delete(key);
      });
    flights.set(key, pending);
    return pending;
  };
}
