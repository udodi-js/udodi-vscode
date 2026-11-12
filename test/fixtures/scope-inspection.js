import { createComponent, html, css } from 'udodi';

const name = 'ordinary';
const ordinaryMessage = `This is ordinary JavaScript: ${name}`;

export const ScopeInspection = createComponent({
	name: 'ScopeInspection',
	template: html`
		<section class="card" @if="user">
			<h1 @text="user.name | capitalise"></h1>
			<ul>
				<li @for="item index items">
					<span @text="index"></span>
					<span @text="item.label"></span>
				</li>
			</ul>
			<button @on="click.prevent=save">Save</button>
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
