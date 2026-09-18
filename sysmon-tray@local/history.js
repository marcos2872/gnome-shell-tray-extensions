export class Ring {
    constructor(max = 120) {
        this.max = max;
        this.data = [];
    }

    push(v) {
        this.data.push(v);
        while (this.data.length > this.max)
            this.data.shift();
    }

    get array() {
        return this.data;
    }

    clear() {
        this.data = [];
    }
}
