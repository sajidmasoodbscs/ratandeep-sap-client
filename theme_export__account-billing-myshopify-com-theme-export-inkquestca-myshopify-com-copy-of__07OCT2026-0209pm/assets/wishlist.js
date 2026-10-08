const Wishlist = {
  key: 'my_wishlist',
  
  get() {
    return JSON.parse(localStorage.getItem(this.key)) || [];
  },
  
  add(handle) {
    let list = this.get();
    if (!list.includes(handle)) {
      list.push(handle);
      localStorage.setItem(this.key, JSON.stringify(list));
    }
  },
  
  remove(handle) {
    let list = this.get();
    list = list.filter(item => item !== handle);
    localStorage.setItem(this.key, JSON.stringify(list));
  },
  
  has(handle) {
    return this.get().includes(handle);
  }
};