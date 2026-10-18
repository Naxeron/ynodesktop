#include <iostream>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0002.lmu", "");
    for (const auto& ev : map->events) {
        if (ev.x == 9 && ev.y == 4) {
            std::cout << "Event ID: " << ev.ID << " Name: " << ev.name << "\n";
            for (size_t i = 0; i < ev.pages.size(); ++i) {
                std::cout << "  Page " << i << " Trigger: " << ev.pages[i].trigger << "\n";
            }
        }
    }
    return 0;
}
