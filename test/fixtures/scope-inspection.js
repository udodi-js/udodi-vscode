import { createComponent, html, css } from 'udodi';

const name = 'ordinary';
const ordinaryMessage = `This is ordinary JavaScript: ${name}`;

export const ScopeInspection = createComponent({
	name: 'ScopeInspection',
	state: {
		user: {
			name: 'celestine attamah',
			lastName: 'attamah'
		},
		items: [
			{ label: 'Item 1' },
			{ label: 'Item 2' },
			{ label: 'Item 3' }
		],
		cardStyle: 'border: 1px solid gray;'
	},
	methods: {
		/**
		 * @param {MouseEvent} event Click event supplied by the @on binding.
		 * @param {string} message Message passed by the @on binding.
		 */
		save(event, message) {
			console.log('Save button clicked:', event, message);
		},
	},
	template: html`
		<section class="card" @style="cardStyle">
			<h1 @text="user.name"></h1>
			<ul>
				<li @for="item index items">
					<span @text="index"></span>
					<span @text="item.label"></span>
				</li>
			</ul>
			<button @on="click.prevent=save:'for testing'">Save</button>
			<p>${ordinaryMessage}</p>
		</section>
	`,
	style: css`
		.card {
			display: grid;
			gap: 1rem;
		}
	`
});
