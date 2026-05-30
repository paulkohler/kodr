import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 3000);
const notesFile = process.env.NOTES_FILE || 'notes.json';
const app = createApp({ notesFile });

app.listen(port, () => {
	console.log(`Notes API listening on http://127.0.0.1:${port}`);
});
