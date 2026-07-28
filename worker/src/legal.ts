import { OpenAPIRoute } from "@cloudflare/itty-router-openapi";

export class LegalCall extends OpenAPIRoute {
    static schema = {
        tags: ["Legal"],
        summary: "tiny.technology Terms of Service",
        parameters: {},
        responses: {
            "200": {
                description: "Successful response",
                schema: {
                    response: 'Welcome to tiny.technology!'
                },
            },
        },
    };

    async handle(
        request: Request,
        env: any,
        _ctx: any,
        data: Record<string, any>
    ) {
        return {
            response: `tiny.technology PLUGIN TERMS OF USE

Acceptance of Terms
By using the tiny.technology Plugin (the "Plugin"), you agree to be bound by these Terms of Use (the "Terms"). If you do not agree to these Terms, you may not use the Plugin.

License
Subject to your compliance with these Terms, tiny.technology grants you a limited, non-exclusive, non-transferable, non-sublicensable license to download and install a copy of the Plugin on a device that you own or control and to run such copy of the Plugin solely for your own personal or business purposes.

Restrictions
You may not: (i) copy, modify or create derivative works based on the Plugin; (ii) distribute, transfer, sublicense, lease, lend or rent the Plugin to any third party; (iii) reverse engineer, decompile or disassemble the Plugin; or (iv) make the functionality of the Plugin available to multiple users through any means.

Ownership
The Plugin is owned and operated by tiny.technology. The visual interfaces, graphics, design, compilation, information, data, computer code, products, software, services, and all other elements of the Plugin are protected by intellectual property rights and other laws.

Privacy
Your use of the Plugin is subject to tiny.technology's Privacy Policy, which is incorporated into these Terms by reference.

Changes to the Terms
tiny.technology reserves the right to modify these Terms at any time. If we make changes to these Terms, we will provide notice of such changes.

Termination
tiny.technology may terminate your access to and use of the Plugin at our sole discretion, at any time and without notice to you.

Disclaimer
The Plugin is provided "as is," without warranty of any kind. tiny.technology disclaims all warranties, whether express or implied, including any warranties of merchantability, fitness for a particular purpose, or non-infringement.

Limitation of Liability
In no event will tiny.technology be liable to you for any indirect, incidental, special, consequential or punitive damages arising out of or relating to your use of the Plugin.

Governing Law
These Terms are governed by the laws of the jurisdiction in which tiny.technology is located, without regard to its conflict of law principles.

` };

    }
}
