// Stub @libsql/client untuk bundel runner Jalur Kedua. Runner TIDAK pernah menyentuh database (getTurso tak dipanggil),
// jadi createClient ini tak pernah jalan. Tujuannya: memutus @libsql (dan ws) dari bundel supaya runner MANDIRI tanpa npm install.
export function createClient() {
	throw new Error("libsql tidak tersedia di runner Jalur Kedua (database hanya di Worker).");
}
export default { createClient };
